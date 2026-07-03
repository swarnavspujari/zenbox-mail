import { create } from "zustand";
import { backend, type MailView } from "@/lib/ipc";
import { assignSplit } from "@/lib/mock";
import { useSettings } from "./settings";
import type { Message, SearchResult, Thread, ThreadId } from "@/lib/types";

interface MailState {
  loaded: boolean;
  inbox: Thread[];
  done: Thread[];
  reminders: Thread[];
  starred: Thread[];

  listView: MailView;
  activeSplitId: string;
  selectedIndex: number;

  openThreadId: ThreadId | null;
  openMessages: Message[];

  searchResults: SearchResult[];

  refresh: () => Promise<void>;
  setListView: (v: MailView) => void;
  setActiveSplit: (id: string) => void;
  cycleSplit: (dir: 1 | -1) => void;
  select: (index: number) => void;
  moveSelection: (dir: 1 | -1) => void;
  openThread: (id: ThreadId) => Promise<void>;
  /** Re-read the open thread's messages (e.g. when inline images resolve). */
  refreshOpenThread: () => Promise<void>;
  closeThread: () => void;

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
  return s.reminders;
}

export const useMail = create<MailState>((set, get) => ({
  loaded: false,
  inbox: [],
  done: [],
  reminders: [],
  starred: [],
  listView: "inbox",
  activeSplitId: "important",
  selectedIndex: 0,
  openThreadId: null,
  openMessages: [],
  searchResults: [],

  refresh: async () => {
    const [inbox, done, reminders, starred] = await Promise.all([
      backend.listThreads("inbox"),
      backend.listThreads("done"),
      backend.listThreads("reminders"),
      backend.listThreads("starred"),
    ]);
    set({ inbox, done, reminders, starred, loaded: true });
    const s = get();
    const max = visibleThreads(s).length - 1;
    if (s.selectedIndex > max) set({ selectedIndex: Math.max(0, max) });
  },

  setListView: (v) => set({ listView: v, selectedIndex: 0 }),

  setActiveSplit: (id) => set({ activeSplitId: id, selectedIndex: 0 }),

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
    set({ activeSplitId: next, selectedIndex: 0 });
  },

  select: (index) => set({ selectedIndex: index }),

  moveSelection: (dir) => {
    const s = get();
    const n = visibleThreads(s).length;
    if (n === 0) return;
    set({ selectedIndex: Math.min(n - 1, Math.max(0, s.selectedIndex + dir)) });
  },

  openThread: async (id) => {
    const msgs = await backend.getThread(id);
    set({ openThreadId: id, openMessages: msgs });
    // reading clears unread locally
    set((s) => ({
      inbox: s.inbox.map((t) => (t.id === id ? { ...t, unread: false } : t)),
      done: s.done.map((t) => (t.id === id ? { ...t, unread: false } : t)),
    }));
  },

  refreshOpenThread: async () => {
    const id = get().openThreadId;
    if (!id) return;
    const msgs = await backend.getThread(id);
    // only apply if the user is still on this thread
    if (get().openThreadId === id) set({ openMessages: msgs });
  },

  closeThread: () => set({ openThreadId: null, openMessages: [] }),

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
    await backend.archiveThread(id);
  },

  hide: async (id, reason) => {
    set((s) => ({
      inbox: s.inbox.filter((t) => t.id !== id),
      done: s.done.filter((t) => t.id !== id),
      reminders: s.reminders.filter((t) => t.id !== id),
      starred: s.starred.filter((t) => t.id !== id),
    }));
    await backend.hideThread(id, reason);
  },

  restore: async (id) => {
    // no cached copy to re-insert; the undo path refreshes after this resolves
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
    set({ searchResults: await backend.search(query) });
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
