import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { isMac } from "./lib/platform";
import { pullPrefs, schedulePush } from "./lib/prefsSync";
// Bundle the UI / reader fonts so Windows and Linux render with the
// same letterforms macOS sees, instead of falling through to Arial / DejaVu.
// Variable-weight woff2 — one file per family covers every weight the styles
// reference (450 / 500 / 550 / 600 / 650 / 700).
import "@fontsource-variable/inter-tight";
import "@fontsource-variable/jetbrains-mono";
import "@fontsource-variable/newsreader";
import "@fontsource-variable/newsreader/wght-italic.css";
// The reader's Hyperlegible choice (READER_FONTS in store.ts) is a static family
// with real italics, so it brings three faces rather than one variable file.
// Shipping it here is also what lets the boot HTML drop its font-CDN link.
import "@fontsource/atkinson-hyperlegible/400.css";
import "@fontsource/atkinson-hyperlegible/400-italic.css";
import "@fontsource/atkinson-hyperlegible/700.css";
import "./styles.css";

// Tag the document root before first paint so the mac-only titlebar chrome
// (overlay strip, sidebar padding for the traffic lights) is gated correctly
// from the very first frame — otherwise Win/Linux would briefly show 38px of
// dead space at the top before a layout-shifting effect runs.
document.documentElement.dataset.platform = isMac ? "mac" : "other";

// Suppress the webview's default context menu — its "Reload / Back / Inspect"
// entries belong to a browser, not a finished app. Editable surfaces still get
// the native menu so paste / select-all / spellcheck stay available. The reader
// supplies its own context menu (copy / save image / …) in ContextMenu.tsx.
window.addEventListener("contextmenu", (e) => {
  const t = e.target as HTMLElement | null;
  if (t?.closest("input, textarea, [contenteditable=''], [contenteditable='true']")) return;
  e.preventDefault();
});

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 30_000, refetchOnWindowFocus: false, retry: 1 },
  },
});

// Boot in an async function rather than with top-level `await`: the app has to
// pause for `pullPrefs` *before* importing the modules that read localStorage
// while their body runs (`./i18n`, `./store`), and a plain async wrapper avoids
// depending on the bundler's top-level-await support.
async function bootstrap() {
  await pullPrefs();
  const [{ default: App }, { useUi }] = await Promise.all([
    import("./App"),
    import("./store"),
  ]);

  // Mirror every preference change back beside the database, so a setting
  // tweaked here is already there when the same drive is opened on another
  // computer. (Coalesced, and skipped when nothing persisted actually changed.)
  useUi.subscribe(() => schedulePush());

  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <ErrorBoundary>
        <QueryClientProvider client={queryClient}>
          <App />
        </QueryClientProvider>
      </ErrorBoundary>
    </React.StrictMode>,
  );
}

void bootstrap();
