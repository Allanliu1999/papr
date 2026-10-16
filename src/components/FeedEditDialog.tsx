import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useFocusTrap } from "../hooks/useFocusTrap";
import { NO_AUTOCORRECT } from "../lib/inputProps";
import FeedAvatar from "./FeedAvatar";
import type { Feed } from "../types";

/** The "never auto-refresh" sentinel the backend uses for a feed opted out of
 *  refreshing (see `db::REFRESH_OFF_MINUTES`). */
const REFRESH_OFF = 525600;

/** What the dialog hands back. The caller diffs this against the feed and
 *  calls only the commands whose value actually changed. */
export interface FeedEditPatch {
  title: string;
  /** A custom icon URL, or `null` to go back to the site's own favicon. */
  faviconUrl: string | null;
  /** `null` follows the global interval; `REFRESH_OFF` means "never". */
  refreshMinutes: number | null;
}

interface Props {
  feed: Feed;
  onSave: (patch: FeedEditPatch) => void;
  onClose: () => void;
}

/**
 * Edit a subscription's name, icon and refresh interval in one dialog.
 *
 * Deliberately its own component rather than an extension of `PromptDialog`:
 * that one is a single-field prompt shared by the tag and folder renames, so
 * growing it into a form would drag those unrelated callers along.
 */
export default function FeedEditDialog({ feed, onSave, onClose }: Props) {
  const { t } = useTranslation();
  const [title, setTitle] = useState(feed.title);
  const [icon, setIcon] = useState(feed.faviconUrl ?? "");
  // Select values are strings; "default" follows the global interval and
  // "off" is the never-refresh sentinel.
  const [interval, setInterval] = useState(() =>
    feed.refreshIntervalMin == null
      ? "default"
      : feed.refreshIntervalMin >= REFRESH_OFF
        ? "off"
        : String(feed.refreshIntervalMin),
  );
  const dialogRef = useRef<HTMLDivElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  useFocusTrap(dialogRef);

  // The name opens pre-selected, so a replacement can be typed immediately.
  useEffect(() => nameRef.current?.select(), []);

  // Escape must close the dialog regardless of which control has focus.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  // Same choices, and the same values, as Settings → Subscriptions. That page
  // keeps its own copy of this list for its per-feed row, so the two are kept
  // in step by hand — change one and change the other.
  const intervalOptions = [
    { value: "default", label: t("settings.subscriptions.refreshDefault") },
    { value: "15", label: t("settings.subscriptions.refresh15m") },
    { value: "30", label: t("settings.subscriptions.refresh30m") },
    { value: "60", label: t("settings.subscriptions.refresh1h") },
    { value: "360", label: t("settings.subscriptions.refresh6h") },
    { value: "720", label: t("settings.subscriptions.refresh12h") },
    { value: "1440", label: t("settings.subscriptions.refresh1d") },
    { value: "off", label: t("settings.subscriptions.refreshOff") },
  ];

  const trimmedTitle = title.trim();
  const trimmedIcon = icon.trim();

  const submit = () => {
    if (!trimmedTitle) return;
    onSave({
      title: trimmedTitle,
      // An emptied field means "no custom icon", not "an icon with a blank
      // URL" — the backend treats a blank string the same way.
      faviconUrl: trimmedIcon || null,
      refreshMinutes:
        interval === "default"
          ? null
          : interval === "off"
            ? REFRESH_OFF
            : Number(interval),
    });
    onClose();
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal"
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="feed-edit-title"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="feed-edit-title">{t("sidebar.editFeedTitle")}</h2>
        <div className="field">
          <label htmlFor="feed-edit-name">{t("sidebar.feedEditName")}</label>
          <input
            id="feed-edit-name"
            className="modal-input"
            ref={nameRef}
            autoFocus
            value={title}
            placeholder={t("sidebar.feedNamePlaceholder")}
            {...NO_AUTOCORRECT}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => {
              // Ignore the Enter that confirms an IME candidate (CJK input).
              if (e.key === "Enter" && !e.nativeEvent.isComposing) submit();
            }}
          />
        </div>
        <div className="field">
          <label htmlFor="feed-edit-icon">{t("sidebar.feedEditIcon")}</label>
          <div className="feed-edit-icon-row">
            {/* Live preview: falls back to the letter avatar when the URL is
                blank or fails to load (FeedAvatar handles the error).
                No size override — it uses `.sb-feed-avatar`'s own default, and
                the container rule in styles.css scales a non-square image down
                to fit rather than cropping it. */}
            <FeedAvatar
              title={trimmedTitle || feed.title}
              faviconUrl={trimmedIcon || null}
              seed={feed.id}
            />
            <input
              id="feed-edit-icon"
              className="modal-input"
              value={icon}
              placeholder={t("sidebar.feedEditIconPlaceholder")}
              {...NO_AUTOCORRECT}
              onChange={(e) => setIcon(e.target.value)}
            />
          </div>
        </div>
        <div className="field">
          <label htmlFor="feed-edit-interval">
            {t("settings.subscriptions.refreshInterval")}
          </label>
          <select
            id="feed-edit-interval"
            className="s-select"
            value={interval}
            onChange={(e) => setInterval(e.target.value)}
          >
            {intervalOptions.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
        <div className="modal-actions">
          <button className="s-btn" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button
            className="s-btn primary"
            onClick={submit}
            disabled={!trimmedTitle}
          >
            {t("common.save")}
          </button>
        </div>
      </div>
    </div>
  );
}
