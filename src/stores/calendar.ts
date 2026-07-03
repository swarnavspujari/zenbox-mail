// Shared, day-keyed event cache so the panel and week view paint instantly
// on reopen/navigation. Reads are local (SQLite / demo fixtures); freshness
// arrives via refreshCalendar + the calendar:updated event.
import { create } from "zustand";
import { backend } from "@/lib/ipc";
import type { CalendarEvent } from "@/lib/types";

export const DAY_MS = 24 * 3600_000;

export function startOfToday(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
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

  shiftDay: (delta: number) => void;
  goToday: () => void;
  /** Local read of [dayStart, dayStart + days), bucketed per day. */
  loadRange: (dayStart: number, days: number) => Promise<void>;
  /** Ask the backend for fresh data around the active range. */
  requestRefresh: () => void;
  /** calendar:updated landed — re-read the active range / surface errors. */
  handleUpdated: (error: string | null) => void;
}

export const useCalendar = create<CalendarState>((set, get) => ({
  eventsByDay: {},
  loadedDays: {},
  error: null,
  dayOffset: 0,
  activeStart: startOfToday(),
  activeDays: 1,

  shiftDay: (delta) => set((s) => ({ dayOffset: s.dayOffset + delta })),
  goToday: () => set({ dayOffset: 0 }),

  loadRange: async (dayStart, days) => {
    set({ activeStart: dayStart, activeDays: days });
    try {
      const events = await backend.listEvents(dayStart, dayStart + days * DAY_MS);
      const byDay: Record<number, CalendarEvent[]> = {};
      const loaded: Record<number, true> = {};
      for (let i = 0; i < days; i++) {
        const d = dayStart + i * DAY_MS;
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
    void s.loadRange(s.activeStart, s.activeDays);
  },
}));
