// Cache-first day/week navigation: loadRange only fetches days missing from
// the day-keyed cache (trimming loaded days off the range ends), the
// calendar:updated reconcile path forces a full re-read, and requestRefresh
// fires at most once per range per throttle window.
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { CalendarEvent } from "@/lib/types";

const backend = vi.hoisted(() => ({
  listEvents: vi.fn(),
  refreshCalendar: vi.fn(),
  listCalendars: vi.fn(),
}));

vi.mock("@/lib/ipc", () => ({ backend, isTauri: false }));

import { clearCalendarThrottle, DAY_MS, useCalendar } from "./calendar";

const DAY0 = new Date(2026, 6, 12).getTime(); // local midnight, Sun Jul 12 2026

function ev(over: Partial<CalendarEvent>): CalendarEvent {
  return {
    id: "e1",
    calendarId: "demo",
    calendar: "Personal",
    color: null,
    title: "Workout",
    startMs: DAY0 + 7 * 3600_000,
    endMs: DAY0 + 8 * 3600_000,
    allDay: false,
    location: null,
    description: null,
    htmlLink: null,
    etag: '"1"',
    status: "confirmed",
    organizerEmail: "you@fission.local",
    organizerSelf: true,
    recurringEventId: null,
    hangoutLink: null,
    attendees: [],
    ...over,
  } as CalendarEvent;
}

beforeEach(() => {
  vi.clearAllMocks();
  clearCalendarThrottle();
  backend.refreshCalendar.mockResolvedValue(undefined);
  useCalendar.setState({
    eventsByDay: {},
    loadedDays: {},
    error: null,
    dayOffset: 0,
    activeStart: DAY0,
    activeDays: 1,
  });
});

describe("loadRange", () => {
  test("cold range fetches and buckets per day", async () => {
    backend.listEvents.mockResolvedValue([ev({})]);
    await useCalendar.getState().loadRange(DAY0, 7);
    expect(backend.listEvents).toHaveBeenCalledWith(DAY0, DAY0 + 7 * DAY_MS);
    const s = useCalendar.getState();
    expect(s.eventsByDay[DAY0]).toHaveLength(1);
    expect(s.eventsByDay[DAY0 + DAY_MS]).toEqual([]);
    expect(s.loadedDays[DAY0 + 6 * DAY_MS]).toBe(true);
  });

  test("fully cached range is a no-op fetch (pure cache paint)", async () => {
    backend.listEvents.mockResolvedValue([]);
    await useCalendar.getState().loadRange(DAY0, 7);
    backend.listEvents.mockClear();
    await useCalendar.getState().loadRange(DAY0, 7);
    expect(backend.listEvents).not.toHaveBeenCalled();
    // the range is still marked active for background reconciles
    expect(useCalendar.getState().activeStart).toBe(DAY0);
    expect(useCalendar.getState().activeDays).toBe(7);
  });

  test("partially cached range only fetches the missing days", async () => {
    backend.listEvents.mockResolvedValue([]);
    await useCalendar.getState().loadRange(DAY0, 7); // week 1 cached
    backend.listEvents.mockClear();
    // shift forward 3 days: days 3-6 are cached, 7-9 are not
    await useCalendar.getState().loadRange(DAY0 + 3 * DAY_MS, 7);
    expect(backend.listEvents).toHaveBeenCalledTimes(1);
    expect(backend.listEvents).toHaveBeenCalledWith(
      DAY0 + 7 * DAY_MS,
      DAY0 + 10 * DAY_MS
    );
  });

  test("force re-reads a cached range (the calendar:updated path)", async () => {
    backend.listEvents.mockResolvedValue([]);
    await useCalendar.getState().loadRange(DAY0, 7);
    backend.listEvents.mockResolvedValue([ev({ title: "New" })]);
    useCalendar.getState().handleUpdated(null);
    await vi.waitFor(() => {
      expect(useCalendar.getState().eventsByDay[DAY0]).toHaveLength(1);
    });
    expect(useCalendar.getState().eventsByDay[DAY0][0].title).toBe("New");
  });
});

describe("requestRefresh", () => {
  test("throttles repeat requests for the same range", () => {
    useCalendar.setState({ activeStart: DAY0, activeDays: 7 });
    useCalendar.getState().requestRefresh();
    useCalendar.getState().requestRefresh();
    expect(backend.refreshCalendar).toHaveBeenCalledTimes(1);
  });

  test("a different range still fires immediately", () => {
    useCalendar.setState({ activeStart: DAY0, activeDays: 7 });
    useCalendar.getState().requestRefresh();
    useCalendar.setState({ activeStart: DAY0 + 7 * DAY_MS, activeDays: 7 });
    useCalendar.getState().requestRefresh();
    expect(backend.refreshCalendar).toHaveBeenCalledTimes(2);
  });
});
