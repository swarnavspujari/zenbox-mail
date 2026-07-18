// Shared, day-keyed event cache so the panel and week view paint instantly
// on reopen/navigation. Reads are local (SQLite / demo fixtures); freshness
// arrives via refreshCalendar + the calendar:updated event. Event modal +
// popover state lives here too (they belong to the calendar views).
import { create } from "zustand";
import { backend } from "@/lib/ipc";
import type { CalendarEvent, CalendarInfo } from "@/lib/types";

export const DAY_MS = 24 * 3600_000;

// One requestRefresh per range per window (see requestRefresh below).
const REFRESH_THROTTLE_MS = 30_000;
const refreshRequestedAt = new Map<string, number>();

/** Test hook: forget which ranges were recently refresh-requested. */
export function clearCalendarThrottle() {
  refreshRequestedAt.clear();
}

export function startOfToday(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** The create/edit event modal. */
export interface EventModalState {
  mode: "create" | "edit";
  /** Edit target (carries id/etag/calendarId + guest context); null = create. */
  event: CalendarEvent | null;
  /** Prefill for create (from a clicked/dragged slot or "New event"). */
  startMs: number;
  endMs: number;
  allDay: boolean;
}

/** The event-details popover, anchored at the click point. */
export interface EventPopoverState {
  event: CalendarEvent;
  x: number;
  y: number;
}

interface CalendarState {
  /** dayStart (local midnight ms) → events overlapping that day. */
  eventsByDay: Record<number, CalendarEvent[]>;
  /** Days a local read has completed for — anything else shows as loading. */
  loadedDays: Record<number, true>;
  error: string | null;
  /** Days from today for the focused day (panel + week view selection). */
  dayOffset: number;
  /** The range views are currently showing, revalidated on updates. */
  activeStart: number;
  activeDays: number;
  /** The account's calendars (modal selector; owner/writer = writable). */
  calendars: CalendarInfo[];
  modal: EventModalState | null;
  popover: EventPopoverState | null;

  shiftDay: (delta: number) => void;
  goToday: () => void;
  /** Jump the focused day to a local-midnight ms (mini-month click). */
  goToDay: (dayStartMs: number) => void;
  /** Local read of [dayStart, dayStart + days), bucketed per day. Days
   *  already in the cache are skipped unless `force` (the calendar:updated
   *  reconcile path) — navigation over loaded days is a pure cache paint. */
  loadRange: (dayStart: number, days: number, opts?: { force?: boolean }) => Promise<void>;
  /** Ask the backend for fresh data around the active range. */
  requestRefresh: () => void;
  /** calendar:updated landed — re-read the active range / surface errors. */
  handleUpdated: (error: string | null) => void;
  /** Refresh the calendarList for the modal's selector. */
  loadCalendars: () => Promise<void>;
  openCreate: (startMs: number, endMs: number, allDay?: boolean) => void;
  openEdit: (event: CalendarEvent) => void;
  closeModal: () => void;
  openPopover: (event: CalendarEvent, x: number, y: number) => void;
  closePopover: () => void;
}

export const useCalendar = create<CalendarState>((set, get) => ({
  eventsByDay: {},
  loadedDays: {},
  error: null,
  dayOffset: 0,
  activeStart: startOfToday(),
  activeDays: 1,
  calendars: [],
  modal: null,
  popover: null,

  shiftDay: (delta) => set((s) => ({ dayOffset: s.dayOffset + delta })),
  goToday: () => set({ dayOffset: 0 }),
  goToDay: (dayStartMs) =>
    set({ dayOffset: Math.round((dayStartMs - startOfToday()) / DAY_MS) }),

  loadRange: async (dayStart, days, opts) => {
    set({ activeStart: dayStart, activeDays: days });
    // Trim already-loaded days off both ends of the range; a fully cached
    // range is a no-op (the views paint straight from eventsByDay).
    let from = dayStart;
    let to = dayStart + days * DAY_MS;
    if (!opts?.force) {
      const loadedDays = get().loadedDays;
      while (from < to && loadedDays[from]) from += DAY_MS;
      while (to > from && loadedDays[to - DAY_MS]) to -= DAY_MS;
      if (from >= to) return;
    }
    try {
      const events = await backend.listEvents(from, to);
      const byDay: Record<number, CalendarEvent[]> = {};
      const loaded: Record<number, true> = {};
      for (let d = from; d < to; d += DAY_MS) {
        byDay[d] = events.filter((e) => e.startMs < d + DAY_MS && e.endMs > d);
        loaded[d] = true;
      }
      set((s) => ({
        eventsByDay: { ...s.eventsByDay, ...byDay },
        loadedDays: { ...s.loadedDays, ...loaded },
        error: null,
      }));
    } catch (e) {
      set({ error: String(e) });
    }
  },

  requestRefresh: () => {
    const s = get();
    // One background sync per range per window: day/week nav shouldn't spam
    // the network (the core throttles too; the mock echoes synchronously).
    // Freshness after writes is untouched — that flows through
    // calendar:updated → handleUpdated, which always re-reads.
    const key = `${s.activeStart}:${s.activeDays}`;
    const last = refreshRequestedAt.get(key) ?? 0;
    if (Date.now() - last < REFRESH_THROTTLE_MS) return;
    refreshRequestedAt.set(key, Date.now());
    void backend
      .refreshCalendar(s.activeStart, s.activeStart + s.activeDays * DAY_MS)
      .catch(() => {});
  },

  handleUpdated: (error) => {
    if (error) {
      set({ error });
      return;
    }
    const s = get();
    void s.loadRange(s.activeStart, s.activeDays, { force: true });
  },

  loadCalendars: async () => {
    try {
      set({ calendars: await backend.listCalendars() });
    } catch {
      // selector falls back to the event's own calendar
    }
  },

  openCreate: (startMs, endMs, allDay = false) => {
    void get().loadCalendars();
    set({
      popover: null,
      modal: { mode: "create", event: null, startMs, endMs, allDay },
    });
  },

  openEdit: (event) => {
    void get().loadCalendars();
    set({
      popover: null,
      modal: {
        mode: "edit",
        event,
        startMs: event.startMs,
        endMs: event.endMs,
        allDay: event.allDay,
      },
    });
  },

  closeModal: () => set({ modal: null }),
  openPopover: (event, x, y) => set({ popover: { event, x, y } }),
  closePopover: () => set({ popover: null }),
}));
