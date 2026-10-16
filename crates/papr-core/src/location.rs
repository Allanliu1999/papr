//! Where Papr keeps its data — and how that location can be moved.
//!
//! Lives in `papr-core` rather than in the desktop shell because **both**
//! front-ends must agree on it: the app opens the database at startup, and the
//! agent CLI resolves the same path on every invocation. Two implementations of
//! "read the pointer, join `papr.db`" would drift apart and leave the CLI
//! reading a different library than the app — exactly the failure this crate
//! exists to prevent.
//!
//! By default the database lives under the platform's app-data directory. A
//! user who wants a portable install — the whole library on a USB stick, opened
//! unchanged on any machine — points Papr at another folder instead.
//!
//! That choice is recorded in a small **pointer file** under the *config*
//! directory, deliberately not inside the data directory itself: the app has to
//! read the pointer before it knows where the data directory is, so the pointer
//! cannot live in there. Keeping the pointer on the machine also means an
//! unplugged drive is always recoverable — the app falls back to the default
//! directory and says so, instead of refusing to start with no way back.
//!
//! Two files travel with the database inside the data directory:
//!   * `papr.db` — the library itself;
//!   * `webview-prefs.json` — the UI preferences, which otherwise live in the
//!     webview's per-machine localStorage and would reset on another computer.

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

/// The pointer file's name, under the app's config directory.
const POINTER_FILE: &str = "data-location.json";
/// The database file's name, under the data directory.
pub const DB_FILE: &str = "papr.db";
/// UI preferences that travel beside the database.
const PREFS_FILE: &str = "webview-prefs.json";

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Pointer {
    data_dir: String,
}

/// Where the data actually is, and how we arrived there.
#[derive(Debug, Clone)]
pub struct Resolved {
    pub dir: PathBuf,
    /// The user has pinned a custom directory (even if it turned out unusable).
    pub custom: bool,
    /// A custom directory was pinned but could not be used, so `dir` is the
    /// default one. The UI surfaces this so the fallback isn't silent.
    pub fell_back: bool,
}

/// The pointer file's path inside `config_dir`.
pub fn pointer_path(config_dir: &Path) -> PathBuf {
    config_dir.join(POINTER_FILE)
}

/// Resolve the data directory: the pinned one when it is usable, otherwise the
/// default. Never fails — an unusable pin degrades to `fell_back`.
pub fn resolve(config_dir: &Path, default_dir: &Path) -> Resolved {
    match read_pointer(config_dir) {
        Some(dir) if is_usable(&dir) => Resolved {
            dir,
            custom: true,
            fell_back: false,
        },
        Some(_) => Resolved {
            dir: default_dir.to_path_buf(),
            custom: true,
            fell_back: true,
        },
        None => Resolved {
            dir: default_dir.to_path_buf(),
            custom: false,
            fell_back: false,
        },
    }
}

/// The pinned directory, if one is set. A blank value counts as unset.
pub fn read_pointer(config_dir: &Path) -> Option<PathBuf> {
    let raw = fs::read_to_string(pointer_path(config_dir)).ok()?;
    let parsed: Pointer = serde_json::from_str(&raw).ok()?;
    let dir = parsed.data_dir.trim();
    if dir.is_empty() {
        None
    } else {
        Some(PathBuf::from(dir))
    }
}

/// Pin `data_dir`, or clear the pin when `None` (restoring the default on the
/// next launch). Removing a pointer that isn't there is a success: absent
/// already means "use the default".
pub fn write_pointer(config_dir: &Path, data_dir: Option<&Path>) -> Result<(), String> {
    fs::create_dir_all(config_dir).map_err(|e| describe("create config dir", e))?;
    let path = pointer_path(config_dir);
    match data_dir {
        Some(dir) => {
            let doc = Pointer {
                data_dir: dir.to_string_lossy().into_owned(),
            };
            let json = serde_json::to_vec_pretty(&doc).map_err(|e| e.to_string())?;
            fs::write(&path, json).map_err(|e| describe("write pointer file", e))
        }
        None => match fs::remove_file(&path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(describe("remove pointer file", e)),
        },
    }
}

/// A pinned directory is usable when it can be created (if absent) and is a
/// directory. An unplugged drive fails right here — its path cannot be created
/// — which is what makes the fallback work.
fn is_usable(dir: &Path) -> bool {
    fs::create_dir_all(dir).is_ok() && dir.is_dir()
}

/// Whether a directory can really be written to, tried rather than inferred: a
/// read-only mount, a full drive and an unplugged drive look different in their
/// metadata but identical to `fs::write`.
fn is_writable(dir: &Path) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|e| describe("create directory", e))?;
    let probe = dir.join(".papr-write-test");
    fs::write(&probe, b"ok").map_err(|e| describe("write to directory", e))?;
    let _ = fs::remove_file(&probe);
    Ok(())
}

/// What a candidate data directory contains — drives the "adopt the existing
/// data or replace it?" question before anything is written.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Probe {
    /// The directory exists (or can be created) and accepts writes.
    pub writable: bool,
    /// A `papr.db` already lives there, i.e. there is a library to adopt.
    pub has_data: bool,
    /// Non-null when `writable` is false.
    pub error: Option<String>,
}

pub fn probe(dir: &Path) -> Probe {
    match is_writable(dir) {
        Ok(()) => Probe {
            writable: true,
            has_data: dir.join(DB_FILE).is_file(),
            error: None,
        },
        Err(e) => Probe {
            writable: false,
            has_data: false,
            error: Some(e),
        },
    }
}

/// Copy the live database into `target` with `VACUUM INTO`.
///
/// `VACUUM INTO` writes a transactionally consistent, compacted copy as a
/// *single* file: there is no WAL or SHM sidecar to move, and no chance of
/// capturing a half-written page the way a plain file copy could. It refuses to
/// overwrite an existing file, which is exactly the guarantee the caller wants
/// — the "destination already holds a library" case is decided in the UI, not
/// silently resolved here.
pub fn copy_db(conn: &Connection, target: &Path) -> Result<(), String> {
    conn.execute("VACUUM INTO ?1", params![target.to_string_lossy()])
        .map(|_| ())
        .map_err(|e| format!("could not write the database to {}: {e}", target.display()))
}

/// Persist the webview's preferences beside the database.
pub fn write_prefs(dir: &Path, json: &str) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|e| describe("create directory", e))?;
    fs::write(dir.join(PREFS_FILE), json).map_err(|e| describe("write preferences", e))
}

/// The preferences saved beside the database, if any. Only well-formed JSON is
/// handed back: the frontend parses it with `JSON.parse`, so a truncated or
/// hand-edited file must not reach it.
pub fn read_prefs(dir: &Path) -> Option<String> {
    let raw = fs::read_to_string(dir.join(PREFS_FILE)).ok()?;
    serde_json::from_str::<serde_json::Value>(&raw).ok()?;
    Some(raw)
}

/// A one-line, path-carrying error message — these surface in dialogs, where
/// the failing path matters more than the io::Error kind.
fn describe(action: &str, e: io::Error) -> String {
    format!("{action}: {e}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    /// A unique scratch directory that cleans itself up.
    struct TempDir(PathBuf);

    impl TempDir {
        fn new(tag: &str) -> Self {
            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let dir = std::env::temp_dir().join(format!(
                "papr-location-{tag}-{}-{nanos}",
                std::process::id()
            ));
            fs::create_dir_all(&dir).unwrap();
            TempDir(dir)
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn resolve_uses_the_default_without_a_pointer() {
        let config = TempDir::new("cfg-none");
        let default = TempDir::new("def-none");
        let r = resolve(config.path(), default.path());
        assert_eq!(r.dir, default.path());
        assert!(!r.custom);
        assert!(!r.fell_back);
    }

    #[test]
    fn a_pointer_round_trips_and_survives_an_unusable_target() {
        let config = TempDir::new("cfg-pin");
        let default = TempDir::new("def-pin");
        let pinned = TempDir::new("pinned");

        write_pointer(config.path(), Some(pinned.path())).unwrap();
        let r = resolve(config.path(), default.path());
        assert_eq!(r.dir, pinned.path());
        assert!(r.custom);
        assert!(!r.fell_back);

        // A pin onto a path that cannot exist (an absent drive) must degrade to
        // the default rather than fail the launch.
        #[cfg(windows)]
        let unreachable = PathBuf::from("Q:\\papr-absent-drive\\data");
        #[cfg(not(windows))]
        let unreachable = PathBuf::from("/proc/papr-cannot-create/data");
        write_pointer(config.path(), Some(&unreachable)).unwrap();
        let r = resolve(config.path(), default.path());
        assert_eq!(r.dir, default.path());
        assert!(r.custom, "the pin is still recorded");
        assert!(r.fell_back, "and the fallback is reported");

        // Clearing the pin restores the plain default.
        write_pointer(config.path(), None).unwrap();
        let r = resolve(config.path(), default.path());
        assert!(!r.custom);
        assert!(!r.fell_back);
    }

    #[test]
    fn clearing_an_absent_pointer_is_a_no_op() {
        let config = TempDir::new("cfg-clear");
        write_pointer(config.path(), None).expect("removing a missing pointer succeeds");
    }

    #[test]
    fn probe_reports_existing_data_and_writability() {
        let empty = TempDir::new("probe-empty");
        let p = probe(empty.path());
        assert!(p.writable);
        assert!(!p.has_data);

        let used = TempDir::new("probe-used");
        fs::write(used.path().join(DB_FILE), b"not really a db").unwrap();
        let p = probe(used.path());
        assert!(p.writable);
        assert!(p.has_data);
    }

    #[test]
    fn prefs_round_trip_and_reject_non_json() {
        let dir = TempDir::new("prefs");
        assert!(read_prefs(dir.path()).is_none());

        write_prefs(dir.path(), r#"{"pref.listTitleOnly":"1"}"#).unwrap();
        assert_eq!(
            read_prefs(dir.path()).as_deref(),
            Some(r#"{"pref.listTitleOnly":"1"}"#)
        );

        // A truncated file must not reach the frontend as invalid JSON.
        fs::write(dir.path().join(PREFS_FILE), "{ not json").unwrap();
        assert!(read_prefs(dir.path()).is_none());
    }

    #[test]
    fn copy_db_writes_a_single_file_and_refuses_to_clobber() {
        let src = TempDir::new("copy-src");
        let dest = TempDir::new("copy-dest");
        let conn = Connection::open(src.path().join("live.db")).unwrap();
        conn.execute_batch("CREATE TABLE t(x); INSERT INTO t VALUES (1);")
            .unwrap();

        let target = dest.path().join(DB_FILE);
        copy_db(&conn, &target).unwrap();
        assert!(target.is_file());

        // The copy is a real, readable database.
        let copied = Connection::open(&target).unwrap();
        let x: i64 = copied.query_row("SELECT x FROM t", [], |r| r.get(0)).unwrap();
        assert_eq!(x, 1);

        // A second copy onto the same path is refused (VACUUM INTO's own rule),
        // which is what lets the caller decide "adopt or replace" explicitly.
        assert!(copy_db(&conn, &target).is_err());
    }
}
