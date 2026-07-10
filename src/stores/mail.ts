import { create } from "zustand";
import { backend, type MailView } from "@/lib/ipc";
import { assignSplit } from "@/lib/mock";
import { reconcilePendingMessages, type PendingMessage } from "@/lib/pending";
import { useSettings } from "./settings";
import type { Message, SearchResult, Thread, ThreadId } from "@/lib/types";

// Guards against a slow full-history search landing after the query moved on.
let lastSearchQuery = "";

// Monotonic id for optimistic reply rows (pending-1, pending-2, …).
let pendingSeq = 1;

interface MailState {
  loaded: boolean;
  inbox: Thread[];
  done: Thread[];
  reminders: Thread[];
  starred: Thread[];
  trash: Thread[];
  /** Threads for the active "label:…" view. */
  labelThreads: Thread[];

  listView: MailView;
  activeSplitId: string;
  selectedIndex: number;
  /** Multi-select for bulk triage; cleared when the view changes. */
  selectedIds: Set<ThreadId>;

  openThreadId: ThreadId | null;
  openMessages: Message[];
  /** Optimistic sent replies for the open thread, shown at the bottom until
   *  the real message lands (see @/lib/pending). Keyed by threadId so they
   *  survive navigating away and back mid-send. */
  pendingMessages: PendingMessage[];

  searchResults: SearchResult[];
  /** A live full-history search is still filling in behind the local results. */
  searchingMore: boolean;
  /** Fetching an older page of the current paged view from Gmail. */
  loadingOlder: boolean;
  /** The current view has no older pages left to fetch. */
  noMoreOlder: boolean;

  refresh: () => Promise<void>;
  setListView: (v: MailView) => void;
  setActiveSplit: (id: string) => void;
  cycleSplit: (dir: 1 | -1) => void;
  select: (index: number) => void;
  moveSelection: (dir: 1 | -1) => void;
  toggleSelected: (id: ThreadId) => void;
  /** Ctrl+A: select the cursor row and everything below it. */
  selectFromCursorDown: () => void;
  clearSelection: () => void;
  openThread: (id: ThreadId) => Promise<void>;
  /** Re-read the open thread's messages (e.g. when inline images resolve). */
  refreshOpenThread: () => Promise<void>;
  closeThread: () => void;
  /** Append an optimistic reply row; returns its localId. */
  addPendingMessage: (pm: Omit<PendingMessage, "localId" | "createdAt">) => string;
  /** Flip a pending reply to sent with its real send time. */
  markPendingSent: (localId: string, sentAt: number) => void;
  /** Drop a pending reply (Undo Send pulled it back to a draft). */
  removePendingMessage: (localId: string) => void;

  archive: (id: ThreadId) => Promise<void>;
  hide: (id: ThreadId, reason: "trash" | "spam") => Promise<void>;
  restore: (id: ThreadId) => Promise<void>;
  mute: (id: ThreadId) => Promise<void>;
  unmute: (id: ThreadId) => Promise<void>;
  toggleStar: (id: ThreadId) => Promise<void>;
  snooze: (id: ThreadId, untilMs: number) => Promise<void>;
  markUnread: (id: ThreadId) => Promise<void>;
  markRead: (id: ThreadId) => Promise<void>;
  moveLabel: (id: ThreadId, label: string) => Promise<void>;
  moveToInbox: (id: ThreadId) => Promise<void>;
  runSearch: (query: string) => Promise<void>;
  loadOlder: () => Promise<void>;
  bulkArchive: (opts: {
    olderThanDays: number;
    preserveUnread: boolean;
    preserveStarred: boolean;
  }) => Promise<number>;
}

/** Threads of the given split, using settings order; "counts show totals". */
export function splitThreads(inbox: Thread[], splitId: string): Thread[] {
  const splits = useSettings.getState().settings.splits;
  return inbox.filter((t) => assignSplit(t, splits) === splitId);
}

export function visibleThreads(s: MailState): Thread[] {
  if (s.listView === "inbox") return splitThreads(s.inbox, s.activeSplitId);
  if (s.listView === "done") return s.done;
  if (s.listView === "starred") return s.starred;
  if (s.listView === "trash") return s.trash;
  if (s.listView.startsWith("label:")) return s.labelThreads;
  return s.reminders;
}

export const useMail = create<MailState>((set, get) => ({
  loaded: false,
  inbox: [],
  done: [],
  reminders: [],
  starred: [],
  trash: [],
  labelThreads: [],
  listView: "inbox",
  activeSplitId: "important",
  selectedIndex: 0,
  selectedIds: new Set<ThreadId>(),
  openThreadId: null,
  openMessages: [],
  pendingMessages: [],
  searchResults: [],
  searchingMore: false,
  loadingOlder: false,
  noMoreOlder: false,

  refresh: async () => {
    const labelView = get().listView.startsWith("label:") ? get().listView : null;
    const [inbox, done, reminders, starred, trash, labelThreads] =
      await Promise.all([
        backend.listThreads("inbox"),
        backend.listThreads("done"),
        backend.listThreads("reminders"),
        backend.listThreads("starred"),
        backend.listThreads("trash"),
        labelView ? backend.listThreads(labelView) : Promise.resolve([]),
      ]);
    set({ inbox, done, reminders, starred, trash, labelThreads, loaded: true });
    const s = get();
    const visible = visibleThreads(s);
    const max = visible.length - 1;
    if (s.selectedIndex > max) set({ selectedIndex: Math.max(0, max) });
    // drop selections that no longer exist in the visible list
    if (s.selectedIds.size > 0) {
      const ids = new Set(visible.map((t) => t.id));
      const pruned = new Set([...s.selectedIds].filter((id) => ids.has(id)));
      if (pruned.size !== s.selectedIds.size) set({ selectedIds: pruned });
    }
  },

  setListView: (v) => {
    set({
      listView: v,
      selectedIndex: 0,
      selectedIds: new Set(),
      labelThreads: [],
      noMoreOlder: false,
    });
    if (v.startsWith("label:")) {
      void backend.listThreads(v).then((labelThreads) => {
        if (get().listView === v) set({ labelThreads });
      });
    }
  },

  setActiveSplit: (id) =>
    set({ activeSplitId: id, selectedIndex: 0, selectedIds: new Set() }),

  cycleSplit: (dir) => {
    const { settings } = useSettings.getState();
    const s = get();
    if (s.listView !== "inbox") return;
    const ids = settings.splits
      .filter(
        (sp) => !sp.hideWhenEmpty || splitThreads(s.inbox, sp.id).length > 0
      )
      .map((sp) => sp.id);
    if (ids.length === 0) return;
    const cur = ids.indexOf(s.activeSplitId);
    const next = ids[(cur + dir + ids.length) % ids.length];
    set({ activeSplitId: next, selectedIndex: 0, selectedIds: new Set() });
  },

  select: (index) => set({ selectedIndex: index }),

  moveSelection: (dir) => {
    const s = get();
    const n = visibleThreads(s).length;
    if (n === 0) return;
    set({ selectedIndex: Math.min(n - 1, Math.max(0, s.selectedIndex + dir)) });
  },

  toggleSelected: (id) => {
    const next = new Set(get().selectedIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    set({ selectedIds: next });
  },

  selectFromCursorDown: () => {
    const s = get();
    const ids = visibleThreads(s)
      .slice(s.selectedIndex)
      .map((t) => t.id);
    set({ selectedIds: new Set(ids) });
  },

  clearSelection: () => set({ selectedIds: new Set() }),

  openThread: async (id) => {
    // switch immediately so J/K feels instant; messages populate right after
    set({ openThreadId: id, openMessages: [] });
    const msgs = await backend.getThread(id);
    if (get().openThreadId !== id) return; // user already moved on
    set((s) => ({
      openMessages: msgs,
      // A reply the user just sent is reconciled away once its real row is in
      // the fetched list (no duplicate); still-in-flight ones stay appended.
      pendingMessages: reconcilePendingMessages(s.pendingMessages, id, msgs.length),
      // reading clears unread locally
      inbox: s.inbox.map((t) => (t.id === id ? { ...t, unread: false } : t)),
      done: s.done.map((t) => (t.id === id ? { ...t, unread: false } : t)),
    }));
    // heal any blank-body message (large HTML behind attachmentId, frozen row…)
    if (msgs.some((m) => !m.bodyHtml && !m.bodyText.trim())) {
      void backend
        .refetchMessageBody(id)
        .then((healed) => {
          if (get().openThreadId === id)
            set((s) => ({
              openMessages: healed,
              pendingMessages: reconcilePendingMessages(
                s.pendingMessages,
                id,
                healed.length
              ),
            }));
        })
        .catch(() => {});
    }
  },

  refreshOpenThread: async () => {
    const id = get().openThreadId;
    if (!id) return;
    const msgs = await backend.getThread(id);
    // only apply if the user is still on this thread
    if (get().openThreadId === id)
      set((s) => ({
        openMessages: msgs,
        pendingMessages: reconcilePendingMessages(s.pendingMessages, id, msgs.length),
      }));
  },

  closeThread: () => set({ openThreadId: null, openMessages: [] }),

  addPendingMessage: (pm) => {
    const localId = `pending-${pendingSeq++}`;
    set((s) => ({
      pendingMessages: [...s.pendingMessages, { ...pm, localId, createdAt: Date.now() }],
    }));
    return localId;
  },

  markPendingSent: (localId, sentAt) =>
    set((s) => ({
      pendingMessages: s.pendingMessages.map((p) =>
        p.localId === localId ? { ...p, status: "sent", sentAt } : p
      ),
    })),

  removePendingMessage: (localId) =>
    set((s) => ({
      pendingMessages: s.pendingMessages.filter((p) => p.localId !== localId),
    })),

  // Triage actions move the thread locally (optimistic) and fire the backend
  // without a trailing refresh() — that was 4 IPC round-trips per keystroke and
  // the source of the input lag. The backend reconciles in the background
  // (debounced mail:updated), so lists still converge after server-side changes.
  archive: async (id) => {
    set((s) => {
      const t = s.inbox.find((t) => t.id === id);
      return {
        inbox: s.inbox.filter((t) => t.id !== id),
        done: t ? [{ ...t, inInbox: false }, ...s.done] : s.done,
      };
    });
    try {
      await backend.archiveThread(id);
    } catch (e) {
      // Rejected before any backend write (e.g. account not connected) —
      // restore the row from the untouched DB, then let the caller surface it.
      // (Remote Gmail failures reconcile separately via triage:error.)
      await get().refresh();
      throw e;
    }
  },

  hide: async (id, reason) => {
    set((s) => {
      const t =
        s.inbox.find((t) => t.id === id) ??
        s.done.find((t) => t.id === id) ??
        s.reminders.find((t) => t.id === id) ??
        s.starred.find((t) => t.id === id) ??
        s.labelThreads.find((t) => t.id === id);
      return {
        inbox: s.inbox.filter((t) => t.id !== id),
        done: s.done.filter((t) => t.id !== id),
        reminders: s.reminders.filter((t) => t.id !== id),
        starred: s.starred.filter((t) => t.id !== id),
        labelThreads: s.labelThreads.filter((t) => t.id !== id),
        trash:
          reason === "trash" && t
            ? [{ ...t, inInbox: false }, ...s.trash]
            : s.trash,
      };
    });
    try {
      await backend.hideThread(id, reason);
    } catch (e) {
      await get().refresh();
      throw e;
    }
  },

  restore: async (id) => {
    // optimistic exit from the trash list; the undo/refresh path re-inserts
    // it wherever it now belongs
    set((s) => ({ trash: s.trash.filter((t) => t.id !== id) }));
    await backend.restoreThread(id);
  },

  mute: async (id) => {
    set((s) => ({ inbox: s.inbox.filter((t) => t.id !== id) }));
    await backend.muteThread(id);
  },

  unmute: async (id) => {
    await backend.unmuteThread(id);
  },

  toggleStar: async (id) => {
    const flip = (list: Thread[]) =>
      list.map((t) => (t.id === id ? { ...t, starred: !t.starred } : t));
    set((s) => ({ inbox: flip(s.inbox), done: flip(s.done), reminders: flip(s.reminders) }));
    await backend.toggleStar(id);
  },

  snooze: async (id, untilMs) => {
    set((s) => {
      const t = s.inbox.find((t) => t.id === id);
      return {
        inbox: s.inbox.filter((t) => t.id !== id),
        reminders: t
          ? [{ ...t, snoozedUntil: untilMs }, ...s.reminders]
          : s.reminders,
      };
    });
    await backend.snoozeThread(id, untilMs);
  },

  markUnread: async (id) => {
    set((s) => ({
      inbox: s.inbox.map((t) => (t.id === id ? { ...t, unread: true } : t)),
    }));
    await backend.markUnread(id);
  },

  markRead: async (id) => {
    set((s) => ({
      inbox: s.inbox.map((t) => (t.id === id ? { ...t, unread: false } : t)),
    }));
    await backend.markRead(id);
  },

  moveLabel: async (id, label) => {
    // optimistic toggle so split reassignment shows instantly
    const toggle = (t: Thread) =>
      t.id === id
        ? {
            ...t,
            labels: t.labels.includes(label)
              ? t.labels.filter((l) => l !== label)
              : [...t.labels, label],
          }
        : t;
    set((s) => ({
      inbox: s.inbox.map(toggle),
      done: s.done.map(toggle),
      reminders: s.reminders.map(toggle),
      starred: s.starred.map(toggle),
    }));
    await backend.moveLabel(id, label);
  },

  moveToInbox: async (id) => {
    set((s) => {
      const t =
        s.done.find((t) => t.id === id) ??
        s.reminders.find((t) => t.id === id) ??
        s.starred.find((t) => t.id === id);
      return {
        done: s.done.filter((t) => t.id !== id),
        reminders: s.reminders.filter((t) => t.id !== id),
        inbox: t ? [{ ...t, inInbox: true, snoozedUntil: null }, ...s.inbox] : s.inbox,
      };
    });
    await backend.moveToInbox(id);
  },

  runSearch: async (query) => {
    lastSearchQuery = query;
    if (!query.trim()) {
      set({ searchResults: [], searchingMore: false });
      return;
    }
    // Instant local results first…
    const local = await backend.search(query);
    if (lastSearchQuery !== query) return;
    set({ searchResults: local, searchingMore: true });
    // …then a live Gmail search so mail older than the local cache is found.
    try {
      const full = await backend.searchAll(query);
      if (lastSearchQuery === query) set({ searchResults: full });
    } catch {
      /* offline / not connected — local results stand */
    } finally {
      if (lastSearchQuery === query) set({ searchingMore: false });
    }
  },

  loadOlder: async () => {
    const s = get();
    if (s.loadingOlder || s.noMoreOlder) return;
    // only the paged archive-style views fetch older pages
    if (!["done", "starred", "trash"].includes(s.listView)) return;
    set({ loadingOlder: true });
    try {
      const added = await backend.loadOlder(s.listView);
      if (added > 0) await get().refresh();
      else set({ noMoreOlder: true });
    } catch {
      /* leave the flags; a later scroll can retry */
    } finally {
      set({ loadingOlder: false });
    }
  },

  bulkArchive: async (opts) => {
    const s = get();
    const n = await backend.bulkArchive({
      splitId: s.listView === "inbox" ? s.activeSplitId : null,
      ...opts,
    });
    await get().refresh();
    return n;
  },
}));
