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
/// The folder Papr keeps its data in by default, beside the executable. Named
/// as shown in the UI, so the two never disagree about capitalisation.
pub const PORTABLE_DIR_NAME: &str = "Data";

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
    /// The default — a `Data` folder beside the executable — could not be
    /// created, so the legacy per-user directory is in use instead. Typically
    /// means an installed build: Windows puts those under `Program Files`,
    /// which is not writable. The caller asks the user what to do.
    pub portable_unavailable: bool,
    /// The legacy directory still holds a library and the portable one does
    /// not, so there is something the user could migrate. The UI offers it.
    pub legacy_library_available: bool,
}

/// The pointer file's path inside `config_dir`.
pub fn pointer_path(config_dir: &Path) -> PathBuf {
    config_dir.join(POINTER_FILE)
}

/// The directory the running executable lives in.
///
/// This — not the process's working directory — is the anchor for a relative
/// data path. A GUI launch has no meaningful working directory (a shortcut
/// typically starts it in `C:\Windows\System32`), so resolving `data` against
/// it would scatter the library somewhere unpredictable.
pub fn app_dir() -> PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(Path::to_path_buf))
        .unwrap_or_else(|| PathBuf::from("."))
}

/// Expand a path the user typed: an absolute one is used as-is, a relative one
/// is taken relative to [`app_dir`].
///
/// Relative is what makes a portable install actually portable — `data` keeps
/// working when the same USB stick is `E:` on one machine and `F:` on the next,
/// where a stored absolute path would point at nothing.
pub fn expand_input(input: &str) -> PathBuf {
    let path = PathBuf::from(input.trim());
    if path.is_absolute() {
        path
    } else {
        app_dir().join(path)
    }
}

/// The default data directory: a `Data` folder beside the executable.
///
/// This is what makes a portable install work — app and library live together
/// on the same stick, so the whole thing keeps working whatever drive letter it
/// gets on the next machine. `resolve` falls back to the legacy per-user
/// directory when this folder can't be created at all (an installed build under
/// `Program Files`).
pub fn portable_data_dir() -> PathBuf {
    app_dir().join(PORTABLE_DIR_NAME)
}

/// Point WebView2's own profile — the home of `localStorage`, where the UI keeps
/// things like collapsed folders and every appearance preference — at the
/// portable data folder.
///
/// This is deliberately separate from the database: WebView2 owns that
/// directory, and by default it sits under `%LOCALAPPDATA%\<identifier>`, which
/// is per-machine. Left alone, a stick-based install would carry the library
/// fine but show the next computer's stale UI state — or none at all — because
/// `localStorage` never travelled.
///
/// Must run before the first webview is created: WebView2 reads the variable
/// once at start-up and the profile cannot be moved afterwards.
///
/// Windows only. macOS's WKWebView and Linux's WebKitGTK expose no equivalent,
/// so there the UI preferences still travel through the `webview-prefs.json`
/// mirror written beside the database.
pub fn configure_webview_profile() {
    #[cfg(windows)]
    {
        let dir = portable_data_dir().join("webview");
        if fs::create_dir_all(&dir).is_ok() {
            // Safe here: called from `run()` before any other thread exists.
            std::env::set_var("WEBVIEW2_USER_DATA_FOLDER", &dir);
        }
    }
}

/// Whether a pre-portable library is sitting in `legacy` while the portable
/// folder has none — the situation the UI offers to migrate. Read-only.
pub fn legacy_library_pending(portable: &Path, legacy: &Path) -> bool {
    !portable.join(DB_FILE).exists() && legacy.join(DB_FILE).is_file()
}

/// Resolve the data directory, in order of preference:
///
/// 1. a directory the user pinned explicitly (Settings → Advanced);
/// 2. the portable default — a `Data` folder beside the executable;
/// 3. `legacy_dir`, the per-user directory older installs used, when the
///    portable one cannot be created at all.
///
/// Never fails. An unusable pin degrades to `fell_back`; an unusable portable
/// default degrades to the legacy directory with `portable_unavailable` set, so
/// the caller can ask the user instead of silently choosing for them.
pub fn resolve(config_dir: &Path, legacy_dir: &Path) -> Resolved {
    let portable = portable_data_dir();

    // 1. An explicit pin wins — including one that failed, which is reported
    //    rather than quietly replaced.
    if let Some(pinned) = read_pointer(config_dir) {
        return if is_usable(&pinned) {
            Resolved {
                dir: pinned,
                custom: true,
                fell_back: false,
                portable_unavailable: false,
                legacy_library_available: false,
            }
        } else {
            Resolved {
                dir: legacy_dir.to_path_buf(),
                custom: true,
                fell_back: true,
                portable_unavailable: false,
                legacy_library_available: false,
            }
        };
    }

    // 2. The portable default. `is_usable` creates the folder, so a read-only
    //    install location fails here rather than at the first write.
    if is_usable(&portable) {
        return Resolved {
            dir: portable.clone(),
            custom: false,
            fell_back: false,
            portable_unavailable: false,
            legacy_library_available: legacy_library_pending(&portable, legacy_dir),
        };
    }

    // 3. Could not create it — an installed build under Program Files. Fall back
    //    to the legacy directory and let the caller surface the choice.
    Resolved {
        dir: legacy_dir.to_path_buf(),
        custom: false,
        fell_back: false,
        portable_unavailable: true,
        legacy_library_available: false,
    }
}

/// The pinned directory, if one is set, with a relative value expanded to where
/// it actually lands ([`expand_input`]). A blank value counts as unset.
///
/// The expansion happens here rather than at write time so the pointer keeps
/// the text the user typed — that is what lets a relative pin survive the
/// drive letter changing between machines.
pub fn read_pointer(config_dir: &Path) -> Option<PathBuf> {
    let raw = fs::read_to_string(pointer_path(config_dir)).ok()?;
    let parsed: Pointer = serde_json::from_str(&raw).ok()?;
    let dir = parsed.data_dir.trim();
    if dir.is_empty() {
        None
    } else {
        Some(expand_input(dir))
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
    fn relative_inputs_anchor_to_the_executable_dir() {
        // An absolute path is taken as written…
        let absolute = std::env::temp_dir().join("papr-absolute-probe");
        assert_eq!(expand_input(absolute.to_string_lossy().as_ref()), absolute);
        // …a relative one anchors to the executable's directory, trimmed.
        assert_eq!(expand_input("  data  "), app_dir().join("data"));
        assert_eq!(portable_data_dir(), app_dir().join("data"));
    }

    /// The pointer has to keep the text the user typed. Storing the expanded
    /// absolute path instead would defeat the point of a portable install: the
    /// pin would break the moment the drive letter changes between machines.
    #[test]
    fn a_relative_pin_is_stored_verbatim_and_expanded_on_read() {
        let config = TempDir::new("cfg-relative");
        write_pointer(config.path(), Some(Path::new("papr-rel-data"))).unwrap();

        let raw = fs::read_to_string(pointer_path(config.path())).unwrap();
        assert!(raw.contains("papr-rel-data"), "stored exactly as typed");

        assert_eq!(
            read_pointer(config.path()),
            Some(app_dir().join("papr-rel-data"))
        );
    }

    /// With no pin, the default is the `Data` folder beside the executable —
    /// that is what makes a stick-based install work on any machine. (The call
    /// creates that folder under the test binary's directory; harmless.)
    #[test]
    fn resolve_defaults_to_the_portable_folder_beside_the_executable() {
        let config = TempDir::new("cfg-none");
        let legacy = TempDir::new("legacy-none");
        let r = resolve(config.path(), legacy.path());
        assert_eq!(r.dir, portable_data_dir());
        assert!(!r.custom);
        assert!(!r.fell_back);
        assert!(!r.portable_unavailable);
        // The legacy directory holds no library here, so nothing is offered.
        assert!(!r.legacy_library_available);
    }

    /// A library left behind at the legacy location is flagged so the UI can
    /// offer to migrate it — and stops being flagged once one exists beside the
    /// executable.
    #[test]
    fn a_legacy_library_is_offered_for_migration() {
        let portable = TempDir::new("portable-empty");
        let legacy = TempDir::new("legacy-full");
        assert!(!legacy_library_pending(portable.path(), legacy.path()));

        fs::write(legacy.path().join(DB_FILE), b"old library").unwrap();
        assert!(legacy_library_pending(portable.path(), legacy.path()));

        fs::write(portable.path().join(DB_FILE), b"new library").unwrap();
        assert!(!legacy_library_pending(portable.path(), legacy.path()));
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
