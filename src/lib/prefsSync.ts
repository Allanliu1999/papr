// UI preferences live in the webview's localStorage, which is per-machine.
// That is normally the right place for them, but it breaks the portable setup:
// a library on a USB stick would arrive on another computer with every
// preference — theme, font size, which feeds are collapsed — silently reset.
//
// So a copy of that store travels beside the database (`webview-prefs.json`,
// read and written through `papr_core::location`). It is pulled in *before* the
// UI modules are imported, because they read localStorage at import time, and
// pushed back (debounced) whenever a preference changes.
//
// Deliberately free of any store import: `main.tsx` pulls this in before the
// store exists. The change subscription is wired up there instead.

import * as api from "../api";

/** Every key the webview persists, as a plain object.
 *
 *  Snapshotting the whole store rather than a whitelist is intentional: this
 *  origin's localStorage belongs to the app alone, so anything in it is ours,
 *  and a key left off a list would be a preference that silently fails to
 *  travel — the exact bug this module exists to prevent. */
function snapshot(): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key != null) out[key] = localStorage.getItem(key) ?? "";
  }
  return out;
}

/** Load the preferences that travel with the library.
 *
 *  Must run before `./i18n` and `./store` are imported — both read
 *  localStorage while their module body executes, so a later import would see
 *  the empty local store and start from the defaults.
 *
 *  Values from the sidecar win, which is what makes "open it on any computer
 *  and the settings are the same" true. A missing or unreadable sidecar (a
 *  normal install, or an unplugged drive) leaves the local values alone. */
export async function pullPrefs(): Promise<void> {
  try {
    const raw = await api.readWebviewPrefs();
    if (!raw) return;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object") return;
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "string") localStorage.setItem(key, value);
    }
  } catch {
    // No sidecar, or it could not be read — the local store stands as it is.
  }
}

/** The current preferences as JSON — handed to `setDataLocation` so they land
 *  beside the database the user just chose, before the relaunch. */
export function dumpPrefs(): string {
  return JSON.stringify(snapshot());
}

/** The last payload written, so a change that doesn't touch a preference (an
 *  article selection, a hover) never causes a write. */
let lastWritten: string | null = null;
let timer: number | undefined;

/** Flush the current preferences beside the database, skipping no-op writes. */
function push(): void {
  const json = dumpPrefs();
  if (json === lastWritten) return;
  lastWritten = json;
  // Swallowed on purpose: with the library on a drive that has been unplugged
  // mid-session, every settings tweak would otherwise raise a dialogs-worth of
  // errors. The next successful write re-syncs everything anyway.
  void api.writeWebviewPrefs(json).catch(() => {});
}

/** Ask for a push, coalescing a burst of changes (a slider drag fires many)
 *  into one write. Safe to call on every store update. */
export function schedulePush(): void {
  if (timer != null) clearTimeout(timer);
  timer = window.setTimeout(() => {
    timer = undefined;
    push();
  }, 800);
}

/** Push immediately — used right before switching the data directory, so the
 *  sidecar at the new location is current even if a change was still pending. */
export function flushPrefs(): void {
  if (timer != null) {
    clearTimeout(timer);
    timer = undefined;
  }
  push();
}
