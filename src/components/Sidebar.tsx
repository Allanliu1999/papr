import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import * as api from "../api";
import { useUi } from "../store";
import { useArticleActions } from "../hooks/articleActions";
import { withUndo, reportError } from "../toast";
import { isMac, modCombo } from "../lib/platform";
import { tagColor, TAG_PALETTE } from "../lib/tagColors";
import type { ArticleQuery, Feed, Folder, Tag } from "../types";
import Icon, { type IconName } from "./Icon";
import ContextMenu, { type MenuEntry } from "./ContextMenu";
import FeedAvatar from "./FeedAvatar";
import PromptDialog from "./PromptDialog";
import FeedEditDialog, { type FeedEditPatch } from "./FeedEditDialog";

interface Props {
  onAddFeed: () => void;
  /** Opens the Add-feed dialog on its Explore tab. */
  onExplore: () => void;
  onOpenSettings: (section?: string) => void;
  onSearchClick: () => void;
  /** Refresh feeds. With no scope refreshes everything (the toolbar button);
   *  pass `{ feedId }` or `{ folderId }` for the per-source context menus. */
  onRefresh: (scope?: { feedId?: number; folderId?: number }) => void;
  refreshing: boolean;
  onToast: (msg: string) => void;
}

const sameQuery = (a: ArticleQuery, b: ArticleQuery) =>  JSON.stringify(a) === JSON.stringify(b);

/** Return `list` with the members of one group re-sequenced to `orderedIds`,
 *  leaving every other row untouched. The sidebar renders each group by
 *  filtering this flat list, so only the relative order *inside* a group is
 *  ever visible — which is also why a reorder never renumbers other groups. */
const applyGroupOrder = (
  list: Feed[],
  folderId: number | null,
  orderedIds: number[],
): Feed[] => {
  const rank = new Map(orderedIds.map((id, i) => [id, i]));
  const slots: number[] = [];
  const items: Feed[] = [];
  list.forEach((f, i) => {
    if (f.folderId === folderId) {
      slots.push(i);
      items.push(f);
    }
  });
  items.sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0));
  const next = [...list];
  slots.forEach((slot, i) => {
    next[slot] = items[i];
  });
  return next;
};

/** Enter / Space activator for a div that behaves as a button — gives the
 *  sidebar's clickable rows keyboard parity with their onClick. */
const onActivate = (fn: () => void) => (e: React.KeyboardEvent) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    fn();
  }
};

type Menu =
  | { x: number; y: number; kind: "feed"; feed: Feed }
  | { x: number; y: number; kind: "folder"; folder: Folder }
  | { x: number; y: number; kind: "tag"; tag: Tag };

type Prompt = {
  title: string;
  initial: string;
  placeholder: string;
  onSubmit: (v: string) => void;
};

function SbItem({
  icon,
  label,
  count,
  active,
  onClick,
}: {
  icon: IconName;
  label: string;
  count?: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <div
      className={`sb-item ${active ? "active" : ""}`}
      role="button"
      tabIndex={0}
      aria-current={active || undefined}
      onClick={onClick}
      onKeyDown={onActivate(onClick)}
    >
      <span className="sb-ico">
        <Icon name={icon} size={15} />
      </span>
      <span className="sb-label">{label}</span>
      {count != null && count > 0 && <span className="sb-count">{count}</span>}
    </div>
  );
}

export default function Sidebar({
  onAddFeed,
  onExplore,
  onOpenSettings,
  onSearchClick,
  onRefresh,
  refreshing,
  onToast,
}: Props) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const actions = useArticleActions();
  const query = useUi((s) => s.query);
  const select = useUi((s) => s.select);
  const showCounts = useUi((s) => s.prefs.showSidebarCounts);
  const unreadOnly = useUi((s) => s.prefs.sidebarUnreadOnly);
  const setPref = useUi((s) => s.setPref);

  const feeds = useQuery({ queryKey: ["feeds"], queryFn: api.listFeeds });
  const folders = useQuery({ queryKey: ["folders"], queryFn: api.listFolders });
  const counts = useQuery({ queryKey: ["counts"], queryFn: api.smartCounts });
  const tags = useQuery({ queryKey: ["tags"], queryFn: api.listTags });

  const [collapsed, setCollapsed] = useState<Record<number, boolean>>(() => {
    try {
      return JSON.parse(localStorage.getItem("collapsedFolders") || "{}");
    } catch {
      return {};
    }
  });
  useEffect(() => {
    localStorage.setItem("collapsedFolders", JSON.stringify(collapsed));
  }, [collapsed]);

  const [menu, setMenu] = useState<Menu | null>(null);
  const [prompt, setPrompt] = useState<Prompt | null>(null);
  // The feed whose Edit dialog is open, if any. A whole `Feed` (not just an
  // id) so the dialog can seed every field and the save path can diff against
  // the values the user actually saw.
  const [feedEdit, setFeedEdit] = useState<Feed | null>(null);
  const [dragId, setDragId] = useState<number | null>(null);
  const [dropFolder, setDropFolder] = useState<number | "none" | null>(null);
  const [tagDragId, setTagDragId] = useState<number | null>(null);
  const [tagOverId, setTagOverId] = useState<number | null>(null);
  // Precise insertion point of a feed drag: the row the drop lands *before*,
  // or `null` for "end of that group". `dropFolder` above stays the
  // whole-container highlight, used when the pointer is over a group but not
  // over any row (an empty folder, the gap below the last row).
  const [dropAt, setDropAt] = useState<{
    folderId: number | null;
    beforeId: number | null;
  } | null>(null);
  // Folder reordering keeps its own drag state so the two drags can never
  // collide: each handler only reacts to its own `…DragId`.
  const [folderDragId, setFolderDragId] = useState<number | null>(null);
  const [folderDrop, setFolderDrop] = useState<{
    id: number;
    below: boolean;
  } | null>(null);

  // Feed/folder/tag mutations only touch the article-bearing caches — a bare
  // invalidateQueries() would also refetch AI summaries, settings and storage
  // stats. refreshAfterBulk() invalidates just the relevant keys.
  const guard = (p: Promise<unknown>, ok: string) =>
    p
      .then(() => {
        actions.refreshAfterBulk();
        onToast(ok);
      })
      .catch((e) => reportError(e));

  // Destructive feed/folder/tag deletes run behind an Undo window: the row
  // disappears at once, but the irreversible backend call is deferred ~6s so
  // a misclick can be taken back. `makeDelete` is a thunk — the backend call
  // must not start until the window actually closes.
  //
  // The optimistic removal also resets a now-dangling selection: the active
  // view, or the open article, may point at the entity that just vanished.
  // Deleting a feed cascade-deletes its articles, so a still-open article
  // from it is closed too (the reader would otherwise show a load error).
  const guardDelete = (
    makeDelete: () => Promise<unknown>,
    toastText: string,
    kind: "feed" | "folder" | "tag",
    id: number,
  ) => {
    const cacheKey =
      kind === "feed" ? "feeds" : kind === "folder" ? "folders" : "tags";
    // Snapshots taken before the optimistic edit, restored verbatim on undo
    // (or if the eventual delete fails).
    const prevList = qc.getQueryData<{ id: number }[]>([cacheKey]);
    const prevFeeds =
      kind === "folder" ? qc.getQueryData<Feed[]>(["feeds"]) : undefined;
    const restore = () => {
      if (prevList) qc.setQueryData([cacheKey], prevList);
      if (prevFeeds) qc.setQueryData(["feeds"], prevFeeds);
    };

    withUndo({
      text: toastText,
      apply: () => {
        qc.setQueryData<{ id: number }[]>([cacheKey], (old) =>
          old?.filter((x) => x.id !== id),
        );
        // Deleting a folder orphans its feeds to "uncategorized" (the DB FK
        // is ON DELETE SET NULL) — mirror that so they don't briefly vanish
        // from the tree during the undo window.
        if (kind === "folder") {
          qc.setQueryData<Feed[]>(["feeds"], (old) =>
            old?.map((f) =>
              f.folderId === id ? { ...f, folderId: null } : f,
            ),
          );
        }
        const st = useUi.getState();
        if (st.query.kind === kind && st.query.value === id) {
          st.select({ kind: "all" }, t("smart.all"));
        } else if (kind === "feed" && st.selectedArticleId != null) {
          const open = qc.getQueryData<{ feedId: number }>([
            "article",
            st.selectedArticleId,
          ]);
          if (open?.feedId === id) st.openArticle(null);
        }
      },
      commit: () => {
        makeDelete()
          .then(() => actions.refreshAfterBulk())
          .catch((e) => {
            restore();
            reportError(e);
          });
      },
      revert: restore,
    });
  };

  const allFeeds = feeds.data ?? [];
  const allFolders = folders.data ?? [];
  const allTags = tags.data ?? [];
  const isActive = (q: ArticleQuery) => sameQuery(q, query);

  // Keep the selected feed in view. Opening an article from search jumps the
  // selection to a feed that may be scrolled out of sight — or hidden inside a
  // collapsed folder — so reveal it whenever the selection changes (issue #75).
  // `block: "nearest"` is a no-op when the row is already visible, so a plain
  // in-sidebar click never jolts the list.
  const activeFeedRef = useRef<HTMLDivElement>(null);
  // Remember which selection we last scrolled to, so a background feeds refetch
  // or an unrelated folder toggle (both re-run this effect) doesn't yank the
  // list back to the active feed.
  const lastScrolledRef = useRef("");
  useEffect(() => {
    const key = JSON.stringify(query);
    if (key === lastScrolledRef.current) return;
    if (query.kind === "feed") {
      const feed = allFeeds.find((f) => f.id === query.value);
      // A collapsed folder doesn't render its feed rows, so there's nothing to
      // scroll to yet — expand it and let this effect re-run (collapsed dep)
      // once the row is mounted.
      if (feed?.folderId != null && collapsed[feed.folderId]) {
        setCollapsed((s) => ({ ...s, [feed.folderId!]: false }));
        return;
      }
    }
    lastScrolledRef.current = key;
    activeFeedRef.current?.scrollIntoView({ block: "nearest" });
  }, [query, allFeeds, collapsed]);

  // "Unread only" hides feeds with nothing unread, decluttering large
  // sidebars. The currently-selected feed is always kept so it doesn't vanish
  // from under the user the moment its last article is marked read, and the
  // filter is suspended mid-drag so a drag target never disappears.
  const feedVisible = (f: Feed) =>
    !unreadOnly ||
    dragId != null ||
    f.unreadCount > 0 ||
    isActive({ kind: "feed", value: f.id });
  const visibleFeeds = allFeeds.filter(feedVisible);
  const ungrouped = visibleFeeds.filter((f) => f.folderId == null);

  // ── drag to reorder a feed, or refile it at a precise spot ──
  //
  // Optimistically apply a new order, then persist and reconcile on either
  // outcome. Mirrors `persistTagOrder`; the toast is only for a refile, since
  // a pure reorder is visible in place and needs no confirmation.
  const persistFeedOrder = (
    next: Feed[],
    call: Promise<unknown>,
    ok?: string,
  ) => {
    qc.setQueryData(["feeds"], next);
    call
      .then(() => {
        actions.refreshAfterBulk();
        if (ok) onToast(ok);
      })
      .catch((e) => reportError(e));
  };

  // `folderId` + `beforeId` fully describe a feed drop: land immediately
  // before `beforeId` inside `folderId`, or at the end of that group when
  // `beforeId` is null. Fed by a drop on a row (precise place) and by a drop
  // on a group container (append).
  const dropFeed = (folderId: number | null, beforeId: number | null) => {
    const feed = allFeeds.find((f) => f.id === dragId);
    setDragId(null);
    setDropFolder(null);
    setDropAt(null);
    if (!feed) return;

    // The destination group *without* the dragged feed — it is re-inserted at
    // the drop point, so a same-group reorder can never duplicate it.
    const rest = allFeeds.filter(
      (f) => f.folderId === folderId && f.id !== feed.id,
    );
    const at =
      beforeId == null ? rest.length : rest.findIndex((f) => f.id === beforeId);
    // `beforeId` should always be in `rest` (the drop handler checked the
    // group), but fall back to the end rather than the start if it is not —
    // that matches "insert where that row used to be".
    const insertAt = at < 0 ? rest.length : at;
    const ordered = [...rest];
    ordered.splice(insertAt, 0, feed);
    const orderedIds = ordered.map((f) => f.id);

    const sameGroup = feed.folderId === folderId;
    if (sameGroup) {
      const current = allFeeds
        .filter((f) => f.folderId === folderId)
        .map((f) => f.id);
      // Dropped back into its own slot — nothing to persist.
      if (orderedIds.join(",") === current.join(",")) return;
    }

    const folderName =
      folderId == null
        ? t("sidebar.uncategorized")
        : allFolders.find((f) => f.id === folderId)?.name ?? "";
    persistFeedOrder(
      applyGroupOrder(
        allFeeds.map((f) => (f.id === feed.id ? { ...f, folderId } : f)),
        folderId,
        orderedIds,
      ),
      sameGroup
        ? api.reorderFeeds(orderedIds)
        : api.moveFeedOrdered(feed.id, folderId, orderedIds),
      sameGroup
        ? undefined
        : t("sidebar.toastMoved", { feed: feed.title, folder: folderName }),
    );
  };

  // Keyboard-reachable counterpart to the drag, which no keyboard can drive.
  const shiftFeed = (feed: Feed, dir: -1 | 1) => {
    const group = allFeeds.filter((f) => f.folderId === feed.folderId);
    const i = group.findIndex((f) => f.id === feed.id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= group.length) return;
    const next = [...group];
    [next[i], next[j]] = [next[j], next[i]];
    const ids = next.map((f) => f.id);
    persistFeedOrder(
      applyGroupOrder(allFeeds, feed.folderId, ids),
      api.reorderFeeds(ids),
    );
  };

  // ── drag to reorder folders ──
  const persistFolderOrder = (next: Folder[]) => {
    qc.setQueryData(["folders"], next);
    api
      .reorderFolders(next.map((fo) => fo.id))
      .catch((e) => reportError(e))
      .finally(() => qc.invalidateQueries({ queryKey: ["folders"] }));
  };

  const shiftFolder = (folder: Folder, dir: -1 | 1) => {
    const i = allFolders.findIndex((fo) => fo.id === folder.id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= allFolders.length) return;
    const next = [...allFolders];
    [next[i], next[j]] = [next[j], next[i]];
    persistFolderOrder(next);
  };

  // `below` places the dragged folder after the hovered one, so the last slot
  // stays reachable (a drop-above-only rule can never move a row to the end).
  const dropFolderAt = (targetId: number, below: boolean) => {
    const from = allFolders.findIndex((fo) => fo.id === folderDragId);
    let to = allFolders.findIndex((fo) => fo.id === targetId);
    setFolderDragId(null);
    setFolderDrop(null);
    if (from < 0 || to < 0) return;
    const next = [...allFolders];
    const [moved] = next.splice(from, 1);
    // Removing the dragged folder shifts every later index down by one.
    if (from < to) to -= 1;
    next.splice(below ? to + 1 : to, 0, moved);
    if (next.map((fo) => fo.id).join(",") === allFolders.map((fo) => fo.id).join(","))
      return;
    persistFolderOrder(next);
  };

  // ── feed / folder context menus ──
  //
  // Apply the edit dialog's result: each field is compared against the feed
  // the dialog was opened on, so an untouched field never issues a redundant
  // write (and a save that changed nothing skips the refresh entirely).
  const saveFeedEdit = (feed: Feed, patch: FeedEditPatch) => {
    const jobs: Promise<unknown>[] = [];
    if (patch.title !== feed.title)
      jobs.push(api.renameFeed(feed.id, patch.title));
    if (patch.faviconUrl !== feed.faviconUrl)
      jobs.push(api.setFeedFavicon(feed.id, patch.faviconUrl));
    if (patch.refreshMinutes !== feed.refreshIntervalMin)
      jobs.push(api.setFeedRefreshInterval(feed.id, patch.refreshMinutes));
    if (!jobs.length) return;
    Promise.all(jobs)
      .then(() => {
        actions.refreshAfterBulk();
        onToast(t("sidebar.toastFeedUpdated"));
      })
      .catch((e) => reportError(e));
  };

  const feedMenu = (f: Feed): MenuEntry[] => {
    const moves: MenuEntry[] = allFolders
      .filter((fo) => fo.id !== f.folderId)
      .map((fo) => ({
        icon: "folder" as const,
        label: t("sidebar.moveToFolder", { folder: fo.name }),
        onClick: () =>
          guard(
            api.moveFeed(f.id, fo.id),
            t("sidebar.toastMovedTo", { folder: fo.name }),
          ),
      }));
    if (f.folderId != null)
      moves.push({
        icon: "folder",
        label: t("sidebar.moveOutOfFolder"),
        onClick: () =>
          guard(api.moveFeed(f.id, null), t("sidebar.toastMovedOut")),
      });
    // Menu counterpart to the drag-reorder, which no keyboard can reach.
    const group = allFeeds.filter((x) => x.folderId === f.folderId);
    const idx = group.findIndex((x) => x.id === f.id);
    const nudge: MenuEntry[] = [];
    if (idx > 0)
      nudge.push({
        icon: "arrow-up",
        label: t("sidebar.moveFeedUp"),
        onClick: () => shiftFeed(f, -1),
      });
    if (idx >= 0 && idx < group.length - 1)
      nudge.push({
        icon: "arrow-down",
        label: t("sidebar.moveFeedDown"),
        onClick: () => shiftFeed(f, 1),
      });
    return [
      ...nudge,
      ...(nudge.length ? [{ separator: true } as MenuEntry] : []),
      {
        icon: "check-all",
        label: t("sidebar.markAllRead"),
        onClick: () =>
          guard(
            api.markAllRead({ kind: "feed", value: f.id }),
            t("sidebar.toastMarkedAllRead"),
          ),
      },
      {
        icon: "refresh",
        label: t("sidebar.refreshFeed"),
        onClick: () => onRefresh({ feedId: f.id }),
      },
      { separator: true },
      {
        icon: "settings",
        label: t("sidebar.editMenu"),
        onClick: () => setFeedEdit(f),
      },
      ...(moves.length ? [{ separator: true } as MenuEntry, ...moves] : []),
      { separator: true },
      {
        icon: "trash",
        label: t("sidebar.unsubscribe"),
        danger: true,
        onClick: () =>
          guardDelete(
            () => api.deleteFeed(f.id),
            t("sidebar.toastUnsubscribed", { feed: f.title }),
            "feed",
            f.id,
          ),
      },
    ];
  };

  const folderMenu = (folder: Folder): MenuEntry[] => {
    // Menu counterpart to the drag-reorder (see `shiftFeed`).
    const idx = allFolders.findIndex((fo) => fo.id === folder.id);
    const nudge: MenuEntry[] = [];
    if (idx > 0)
      nudge.push({
        icon: "arrow-up",
        label: t("sidebar.moveFolderUp"),
        onClick: () => shiftFolder(folder, -1),
      });
    if (idx >= 0 && idx < allFolders.length - 1)
      nudge.push({
        icon: "arrow-down",
        label: t("sidebar.moveFolderDown"),
        onClick: () => shiftFolder(folder, 1),
      });
    return [
      ...nudge,
      ...(nudge.length ? [{ separator: true } as MenuEntry] : []),
      {
        icon: "check-all",
        label: t("sidebar.markAllRead"),
        onClick: () =>
          guard(
            api.markAllRead({ kind: "folder", value: folder.id }),
            t("sidebar.toastMarkedAllRead"),
          ),
      },
    {
      icon: "refresh",
      label: t("sidebar.refreshFolder"),
      onClick: () => onRefresh({ folderId: folder.id }),
    },
    { separator: true },
    {
      icon: "settings",
      label: t("sidebar.renameMenu"),
      onClick: () =>
        setPrompt({
          title: t("sidebar.renameFolderTitle"),
          initial: folder.name,
          placeholder: t("sidebar.folderNamePlaceholder"),
          onSubmit: (v) =>
            guard(api.renameFolder(folder.id, v), t("sidebar.toastRenamed")),
        }),
    },
    { separator: true },
    {
      icon: "trash",
      label: t("sidebar.deleteFolder"),
      danger: true,
      onClick: () =>
        guardDelete(
          () => api.deleteFolder(folder.id),
          t("sidebar.toastFolderDeleted"),
          "folder",
          folder.id,
        ),
    },
  ];
  };

  const tagMenu = (tag: Tag): MenuEntry[] => {
    const idx = allTags.findIndex((tg) => tg.id === tag.id);
    return [
    // Drag-reorder isn't reachable by keyboard — these give it parity.
    ...(idx > 0
      ? ([
          {
            icon: "arrow-up",
            label: t("sidebar.moveTagUp"),
            onClick: () => moveTag(tag.id, -1),
          },
        ] as MenuEntry[])
      : []),
    ...(idx >= 0 && idx < allTags.length - 1
      ? ([
          {
            icon: "arrow-down",
            label: t("sidebar.moveTagDown"),
            onClick: () => moveTag(tag.id, 1),
          },
        ] as MenuEntry[])
      : []),
    ...(allTags.length > 1 ? [{ separator: true } as MenuEntry] : []),
    {
      icon: "settings",
      label: t("sidebar.renameMenu"),
      onClick: () =>
        setPrompt({
          title: t("sidebar.renameTagTitle"),
          initial: tag.name,
          placeholder: t("sidebar.tagNamePlaceholder"),
          onSubmit: (v) =>
            guard(api.renameTag(tag.id, v), t("sidebar.toastRenamed")),
        }),
    },
    {
      swatches: Object.entries(TAG_PALETTE).map(([value, color]) => ({
        value,
        color,
      })),
      current: tag.color,
      // The recolour is instantly visible on the dot, so no toast — just
      // refresh the caches that embed the tag colour.
      onPick: (color) =>
        api
          .setTagColor(tag.id, color)
          .then(() => actions.refreshAfterBulk())
          .catch((e) => reportError(e)),
    },
    { separator: true },
    {
      icon: "trash",
      label: t("sidebar.deleteTag"),
      danger: true,
      onClick: () =>
        guardDelete(
          () => api.deleteTag(tag.id),
          t("sidebar.toastTagDeleted"),
          "tag",
          tag.id,
        ),
    },
    ];
  };

  const createTag = () =>
    setPrompt({
      title: t("sidebar.newTagTitle"),
      initial: "",
      placeholder: t("sidebar.tagNamePlaceholder"),
      onSubmit: (v) => guard(api.createTag(v), t("sidebar.toastTagCreated")),
    });

  // Creating a folder only touches the folders list, which `refreshAfterBulk`
  // (and thus `guard`) doesn't cover — invalidate it explicitly.
  const createFolder = () =>
    setPrompt({
      title: t("app.newFolderTitle"),
      initial: "",
      placeholder: t("app.folderNamePlaceholder"),
      onSubmit: (v) =>
        api
          .createFolder(v)
          .then(() => {
            qc.invalidateQueries({ queryKey: ["folders"] });
            onToast(t("app.folderCreated"));
          })
          .catch((e) => reportError(e)),
    });

  // Optimistically apply a new tag order, then persist; reconcile on either
  // outcome. Shared by the drag-reorder and the menu's move up/down.
  const persistTagOrder = (next: Tag[]) => {
    qc.setQueryData(["tags"], next);
    api
      .reorderTags(next.map((tg) => tg.id))
      .catch((e) => reportError(e))
      .finally(() => qc.invalidateQueries({ queryKey: ["tags"] }));
  };

  // ── drag to reorder tags ──
  const dropTag = (targetId: number) => {
    const from = allTags.findIndex((tg) => tg.id === tagDragId);
    const to = allTags.findIndex((tg) => tg.id === targetId);
    setTagDragId(null);
    setTagOverId(null);
    if (from < 0 || to < 0 || from === to) return;
    const next = [...allTags];
    const [moved] = next.splice(from, 1);
    // The `drop-above` indicator marks an insertion point *before* the target
    // tag. After removing the dragged item, every index past `from` shifts
    // down by one — so a downward drag must insert at `to - 1` to land the
    // tag above the target, not below it.
    const insertAt = from < to ? to - 1 : to;
    next.splice(insertAt, 0, moved);
    persistTagOrder(next);
  };

  // Keyboard-reachable counterpart to the drag-reorder: swap a tag with its
  // neighbour. `dir` is -1 (up) or 1 (down).
  const moveTag = (tagId: number, dir: -1 | 1) => {
    const i = allTags.findIndex((tg) => tg.id === tagId);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= allTags.length) return;
    const next = [...allTags];
    [next[i], next[j]] = [next[j], next[i]];
    persistTagOrder(next);
  };

  // ── feed row ──
  const feedRow = (f: Feed, lastInGroup: boolean) => (
    <div
      key={f.id}
      ref={isActive({ kind: "feed", value: f.id }) ? activeFeedRef : undefined}
      className={`sb-item ${
        isActive({ kind: "feed", value: f.id }) ? "active" : ""
      } ${dragId === f.id ? "dragging" : ""} ${
        dropAt?.folderId === f.folderId && dropAt.beforeId === f.id
          ? "drop-above"
          : ""
      } ${
        dropAt?.folderId === f.folderId &&
        dropAt.beforeId === null &&
        lastInGroup
          ? "drop-below"
          : ""
      }`}
      role="button"
      tabIndex={0}
      aria-current={isActive({ kind: "feed", value: f.id }) || undefined}
      draggable
      onDragStart={(e) => {
        // HTML5 dragging does not start at all unless the source puts something
        // in the dataTransfer: Firefox enforces it, and WebView2 is not
        // guaranteed to be lenient. The payload is never read — the drop
        // handlers work off the ids held in React state — so any non-empty
        // entry will do.
        e.dataTransfer.setData("text/plain", String(f.id));
        e.dataTransfer.effectAllowed = "move";
        setDragId(f.id);
      }}
      onDragEnd={() => {
        setDragId(null);
        setDropFolder(null);
        setDropAt(null);
      }}
      onDragOver={(e) => {
        // Ignore this row while it is the dragged one, and whenever a *folder*
        // is being dragged (that gesture sorts folders, not feeds).
        if (dragId == null || dragId === f.id) return;
        e.preventDefault();
        // Claim the event, so the enclosing group container doesn't also read
        // the pointer as "over the group, not over a row" (append to the end).
        e.stopPropagation();
        const box = e.currentTarget.getBoundingClientRect();
        const below = e.clientY > box.top + box.height / 2;
        // The point *after* this row is the next row of the same group — and
        // `null` once there is none, meaning "end of the group". The dragged
        // feed is excluded so the index matches the post-move list.
        const group = allFeeds.filter(
          (x) => x.folderId === f.folderId && x.id !== dragId,
        );
        const i = group.findIndex((x) => x.id === f.id);
        setDropAt({
          folderId: f.folderId,
          beforeId: below ? group[i + 1]?.id ?? null : f.id,
        });
        setDropFolder(null);
      }}
      onDrop={(e) => {
        if (dragId == null) return;
        e.preventDefault();
        e.stopPropagation();
        const beforeId =
          dropAt && dropAt.folderId === f.folderId ? dropAt.beforeId : null;
        dropFeed(f.folderId, beforeId);
      }}
      onClick={() => select({ kind: "feed", value: f.id }, f.title)}
      onKeyDown={onActivate(() => select({ kind: "feed", value: f.id }, f.title))}
      onContextMenu={(e) => {
        e.preventDefault();
        setMenu({ x: e.clientX, y: e.clientY, kind: "feed", feed: f });
      }}
      title={f.fetchError ?? f.title}
    >
      <FeedAvatar title={f.title} faviconUrl={f.faviconUrl} seed={f.id} />
      <span className="sb-label">{f.title}</span>
      {f.fetchError && (
        <span className="sb-warn" role="img" aria-label={t("sidebar.feedError")}>
          !
        </span>
      )}
      {showCounts && f.unreadCount > 0 && (
        <span className="sb-count">{f.unreadCount}</span>
      )}
    </div>
  );

  return (
    <div className="sidebar" role="navigation">
      {isMac && <div className="titlebar" data-tauri-drag-region />}

      {isMac && (
        <div className="sb-brand">
          <img className="sb-brand-mark" src="/papr.svg" alt="" />
          <span className="sb-brand-name">Papr</span>
        </div>
      )}

      <div
        className="sidebar-search"
        role="button"
        tabIndex={0}
        onClick={onSearchClick}
        onKeyDown={onActivate(onSearchClick)}
      >
        <Icon name="search" size={13} />
        <span>{t("sidebar.searchArticles")}</span>
        <kbd>{modCombo("K")}</kbd>
      </div>

      <div className="sidebar-scroll">
        <div className="sb-section-title">
          <span>{t("sidebar.library")}</span>
        </div>
        <SbItem
          icon="inbox"
          label={t("smart.all")}
          active={isActive({ kind: "all" })}
          onClick={() => select({ kind: "all" }, t("smart.all"))}
        />
        <SbItem
          icon="unread"
          label={t("smart.unread")}
          count={showCounts ? counts.data?.unread : undefined}
          active={isActive({ kind: "unread" })}
          onClick={() => select({ kind: "unread" }, t("smart.unread"))}
        />
        <SbItem
          icon="star"
          label={t("smart.starred")}
          count={showCounts ? counts.data?.starred : undefined}
          active={isActive({ kind: "starred" })}
          onClick={() => select({ kind: "starred" }, t("smart.starred"))}
        />
        <SbItem
          icon="bookmark"
          label={t("smart.readLater")}
          count={showCounts ? counts.data?.readLater : undefined}
          active={isActive({ kind: "readLater" })}
          onClick={() => select({ kind: "readLater" }, t("smart.readLater"))}
        />

        <div className="sb-section-title">
          <span>{t("sidebar.feeds")}</span>
          <span className="sb-section-actions">
            <button
              className={unreadOnly ? "active" : ""}
              onClick={() => setPref({ sidebarUnreadOnly: !unreadOnly })}
              title={t("sidebar.unreadOnly")}
              aria-label={t("sidebar.unreadOnly")}
              aria-pressed={unreadOnly}
            >
              <Icon name={unreadOnly ? "eye-off" : "eye"} size={12} />
            </button>
            <button
              onClick={createFolder}
              title={t("app.newFolderTitle")}
              aria-label={t("app.newFolderTitle")}
            >
              <Icon name="folder" size={12} />
            </button>
            <button
              onClick={onAddFeed}
              title={t("sidebar.addFeed")}
              aria-label={t("sidebar.addFeed")}
            >
              <Icon name="plus" size={12} />
            </button>
          </span>
        </div>

        {allFeeds.length === 0 && (
          <div
            style={{
              padding: "10px 12px",
              fontSize: 12,
              color: "var(--muted)",
              lineHeight: 1.5,
            }}
          >
            {t("sidebar.emptyHint")}
          </div>
        )}

        {allFeeds.length > 0 && unreadOnly && visibleFeeds.length === 0 && (
          <div
            style={{
              padding: "10px 12px",
              fontSize: 12,
              color: "var(--muted)",
              lineHeight: 1.5,
            }}
          >
            {t("sidebar.allReadHint")}
          </div>
        )}

        {/* Ungrouped feeds — also the drop zone for "move out of folder".
            Rendered whenever there are ungrouped feeds, OR while a feed drag
            is in progress: without the latter, a drag-to-ungroup would have
            no target to land on once every feed lives inside a folder. */}
        {(ungrouped.length > 0 ||
          (dragId != null &&
            allFeeds.find((f) => f.id === dragId)?.folderId != null)) && (
          <div
            onDragOver={(e) => {
              if (dragId != null) {
                e.preventDefault();
                setDropFolder("none");
                // The pointer is over the group, not over a row: fall back to
                // "append to the end" and clear any row-level indicator.
                setDropAt(null);
              }
            }}
            onDrop={() => dropFeed(null, null)}
            style={
              dropFolder === "none"
                ? { outline: "2px solid var(--accent)", borderRadius: 8 }
                : undefined
            }
          >
            {ungrouped.length > 0 ? (
              ungrouped.map((f, i) => feedRow(f, i === ungrouped.length - 1))
            ) : (
              <div className="sb-drop-hint">{t("sidebar.dropUngroup")}</div>
            )}
          </div>
        )}

        {allFolders.map((folder) => {
          const inFolder = visibleFeeds.filter((f) => f.folderId === folder.id);
          // In "unread only" mode an empty folder is hidden — unless a drag is
          // active, when it must stay as a drop target. That covers a folder
          // *reorder* too: during one, the dragged folder must stay on screen
          // and its siblings must stay reachable, empty or not.
          if (
            unreadOnly &&
            dragId == null &&
            inFolder.length === 0 &&
            folder.id !== folderDragId
          )
            return null;
          const isCollapsed = collapsed[folder.id];
          const folderActive = isActive({ kind: "folder", value: folder.id });
          // Aggregate unread for the folder. Shown while collapsed or when the
          // folder is the active view — expanded *and* not selected, the
          // per-feed badges already carry the same signal and a header total
          // would just duplicate them.
          const folderUnread = inFolder.reduce((n, f) => n + f.unreadCount, 0);
          return (
            <div
              key={folder.id}
              onDragOver={(e) => {
                if (dragId != null) {
                  e.preventDefault();
                  setDropFolder(folder.id);
                  // Over the group, not over one of its rows: append to end.
                  setDropAt(null);
                }
              }}
              onDrop={() => dropFeed(folder.id, null)}
              style={
                dropFolder === folder.id
                  ? { outline: "2px solid var(--accent)", borderRadius: 8 }
                  : undefined
              }
            >
              <div
                className={`sb-folder ${isCollapsed ? "collapsed" : ""} ${
                  folderActive ? "active" : ""
                } ${folderDragId === folder.id ? "dragging" : ""} ${
                  folderDrop?.id === folder.id
                    ? folderDrop.below
                      ? "drop-below"
                      : "drop-above"
                    : ""
                }`}
                role="button"
                tabIndex={0}
                aria-current={folderActive || undefined}
                draggable
                onDragStart={(e) => {
                  // HTML5 dragging does not start at all unless the source puts
                  // something in the dataTransfer: Firefox enforces it, and
                  // WebView2 is not guaranteed to be lenient. The payload is
                  // never read — the drop handlers work off React state.
                  e.dataTransfer.setData("text/plain", String(folder.id));
                  e.dataTransfer.effectAllowed = "move";
                  setFolderDragId(folder.id);
                }}
                onDragEnd={() => {
                  setFolderDragId(null);
                  setFolderDrop(null);
                }}
                onDragOver={(e) => {
                  // Only a folder drag sorts folders. A *feed* drag passing
                  // over this header is left to the enclosing container, which
                  // reads it as "drop the feed into this folder".
                  if (folderDragId == null || folderDragId === folder.id) return;
                  e.preventDefault();
                  e.stopPropagation();
                  const box = e.currentTarget.getBoundingClientRect();
                  setFolderDrop({
                    id: folder.id,
                    below: e.clientY > box.top + box.height / 2,
                  });
                }}
                onDrop={(e) => {
                  if (folderDragId == null) return;
                  e.preventDefault();
                  e.stopPropagation();
                  dropFolderAt(
                    folder.id,
                    folderDrop?.id === folder.id ? folderDrop.below : false,
                  );
                }}
                onClick={() => select({ kind: "folder", value: folder.id }, folder.name)}
                onKeyDown={onActivate(() =>
                  select({ kind: "folder", value: folder.id }, folder.name),
                )}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setMenu({ x: e.clientX, y: e.clientY, kind: "folder", folder });
                }}
              >
                {/* The chevron is the expand/collapse affordance; clicking the
                    folder name selects the folder's combined article view. */}
                <button
                  type="button"
                  className="sb-folder-toggle"
                  aria-label={t(
                    isCollapsed ? "sidebar.expandFolder" : "sidebar.collapseFolder",
                  )}
                  aria-expanded={!isCollapsed}
                  onClick={(e) => {
                    e.stopPropagation();
                    setCollapsed((s) => ({ ...s, [folder.id]: !isCollapsed }));
                  }}
                >
                  <Icon name="chevron-down" size={11} />
                </button>
                <span className="sb-folder-name">{folder.name}</span>
                {showCounts && (isCollapsed || folderActive) && folderUnread > 0 && (
                  <span className="sb-count">{folderUnread}</span>
                )}
              </div>
              {!isCollapsed &&
                inFolder.map((f, i) => feedRow(f, i === inFolder.length - 1))}
            </div>
          );
        })}

        <div className="sb-section-title">
          <span>{t("sidebar.tags")}</span>
          <button
            onClick={createTag}
            title={t("sidebar.newTagTitle")}
            aria-label={t("sidebar.newTagTitle")}
          >
            <Icon name="plus" size={12} />
          </button>
        </div>
        {allTags.length === 0 && (
          <div
            style={{
              padding: "4px 12px 2px",
              fontSize: 11.5,
              color: "var(--muted)",
              lineHeight: 1.5,
            }}
          >
            {t("sidebar.tagsEmptyHint")}
          </div>
        )}
        {allTags.map((tag) => (
          <div
            key={tag.id}
            className={`sb-item ${
              isActive({ kind: "tag", value: tag.id }) ? "active" : ""
            } ${tagDragId === tag.id ? "dragging" : ""} ${
              tagOverId === tag.id ? "drop-above" : ""
            }`}
            role="button"
            tabIndex={0}
            aria-current={isActive({ kind: "tag", value: tag.id }) || undefined}
            draggable
            onDragStart={(e) => {
              // HTML5 dragging does not start at all unless the source puts
              // something in the dataTransfer: Firefox enforces it, and
              // WebView2 is not guaranteed to be lenient. The payload is never
              // read — the drop handlers work off the ids held in React state
              // — so any non-empty entry will do.
              e.dataTransfer.setData("text/plain", String(tag.id));
              e.dataTransfer.effectAllowed = "move";
              setTagDragId(tag.id);
            }}
            onDragEnd={() => {
              setTagDragId(null);
              setTagOverId(null);
            }}
            onDragOver={(e) => {
              if (tagDragId != null && tagDragId !== tag.id) {
                e.preventDefault();
                setTagOverId(tag.id);
              }
            }}
            onDrop={() => dropTag(tag.id)}
            onClick={() => select({ kind: "tag", value: tag.id }, tag.name)}
            onKeyDown={onActivate(() =>
              select({ kind: "tag", value: tag.id }, tag.name),
            )}
            onContextMenu={(e) => {
              e.preventDefault();
              setMenu({ x: e.clientX, y: e.clientY, kind: "tag", tag });
            }}
          >
            <span className="sb-ico">
              <span
                className="tag-dot"
                style={{ background: tagColor(tag.color) }}
              />
            </span>
            <span className="sb-label">{tag.name}</span>
            {showCounts && tag.articleCount > 0 && (
              <span className="sb-count">{tag.articleCount}</span>
            )}
          </div>
        ))}

        <div style={{ height: 30 }} />
      </div>

      <div className="sb-footer">
        <button
          title={t("sidebar.addFeedShortcut")}
          aria-label={t("sidebar.addFeedShortcut")}
          onClick={onAddFeed}
        >
          <Icon name="plus" size={14} />
        </button>
        <button
          title={t("sidebar.refreshAll")}
          aria-label={t("sidebar.refreshAll")}
          onClick={() => onRefresh()}
          disabled={refreshing}
          className={refreshing ? "spinning" : ""}
        >
          <Icon name="refresh" size={14} />
        </button>
        <button
          title={t("sidebar.explore")}
          aria-label={t("sidebar.explore")}
          onClick={onExplore}
        >
          <Icon name="globe" size={14} />
        </button>
        <div className="spacer" />
        <button
          title={t("sidebar.settings")}
          aria-label={t("sidebar.settings")}
          onClick={() => onOpenSettings()}
        >
          <Icon name="settings" size={14} />
        </button>
      </div>

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={
            menu.kind === "feed"
              ? feedMenu(menu.feed)
              : menu.kind === "folder"
                ? folderMenu(menu.folder)
                : tagMenu(menu.tag)
          }
          onClose={() => setMenu(null)}
        />
      )}
      {prompt && (
        <PromptDialog
          title={prompt.title}
          initialValue={prompt.initial}
          placeholder={prompt.placeholder}
          onSubmit={prompt.onSubmit}
          onClose={() => setPrompt(null)}
        />
      )}
      {feedEdit && (
        <FeedEditDialog
          feed={feedEdit}
          onSave={(patch) => saveFeedEdit(feedEdit, patch)}
          onClose={() => setFeedEdit(null)}
        />
      )}
    </div>
  );
}
