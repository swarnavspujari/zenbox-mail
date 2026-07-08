// Full-screen week view (design system calendar week): 7-day grid over the
// shared day-keyed event cache, today column tinted, now-line, ‹ › weeks and
// ←/→ day-stepping via calendar.prevDay/nextDay. Click an event for
// details/RSVP; click or drag an empty slot to create one.
import { useEffect, useMemo, useRef, useState } from "react";
import { DAY_MS, startOfToday, useCalendar } from "@/stores/calendar";
import { rsvpClasses } from "./CalendarPanel";
import type { CalendarEvent } from "@/lib/types";

const FIRST_HOUR = 7;
const LAST_HOUR = 20;
const PX_PER_HOUR = 46;

function hourLabel(h: number): string {
  if (h === 12) return "12 pm";
  return h < 12 ? `${h} am` : `${h - 12} pm`;
}

function WeekEvent({ e, dayStart }: { e: CalendarEvent; dayStart: number }) {
  const gridStart = dayStart + FIRST_HOUR * 3600_000;
  const gridEnd = dayStart + LAST_HOUR * 3600_000;
  const s = Math.max(e.startMs, gridStart);
  const end = Math.min(Math.max(e.endMs, s + 15 * 60_000), gridEnd);
  if (end <= gridStart || s >= gridEnd) return null;
  const top = ((s - gridStart) / 3600_000) * PX_PER_HOUR;
  const height = Math.max(18, ((end - s) / 3600_000) * PX_PER_HOUR - 2);
  return (
    <button
      className={`absolute left-0.5 right-0.5 overflow-hidden rounded-[5px] border border-accent/30 bg-accent-dim px-1.5 py-0.5 text-left hover:border-accent/60 ${rsvpClasses(e)}`}
      style={{ top, height }}
      title={e.title}
      onMouseDown={(ev) => ev.stopPropagation()}
      onClick={(ev) => {
        ev.stopPropagation();
        useCalendar.getState().openPopover(e, ev.clientX, ev.clientY);
      }}
    >
      <div className="truncate text-[11px] font-medium leading-[14px] text-ink">
        {e.title}
      </div>
    </button>
  );
}

export function CalendarWeek() {
  const dayOffset = useCalendar((s) => s.dayOffset);
  const eventsByDay = useCalendar((s) => s.eventsByDay);
  const loadedDays = useCalendar((s) => s.loadedDays);
  const error = useCalendar((s) => s.error);
  const [nowTick, setNowTick] = useState(Date.now());
  const [drag, setDrag] = useState<{ day: number; from: number; to: number } | null>(
    null
  );
  const colRefs = useRef<Record<number, HTMLDivElement | null>>({});
  const scrollRef = useRef<HTMLDivElement>(null);

  const focusedDay = useMemo(
    () => startOfToday() + dayOffset * DAY_MS,
    [dayOffset]
  );
  // week starts on Sunday, local time
  const weekStart = useMemo(
    () => focusedDay - new Date(focusedDay).getDay() * DAY_MS,
    [focusedDay]
  );
  const days = useMemo(
    () => Array.from({ length: 7 }, (_, i) => weekStart + i * DAY_MS),
    [weekStart]
  );
  const today = startOfToday();

  useEffect(() => {
    const cal = useCalendar.getState();
    void cal.loadRange(weekStart, 7);
    cal.requestRefresh();
  }, [weekStart]);

  useEffect(() => {
    const t = setInterval(() => setNowTick(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);

  // On open, center the current time in the grid (Google-style). No-op when the
  // whole 7am–8pm grid already fits without scrolling.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const now = new Date();
    const nowH = now.getHours() + now.getMinutes() / 60;
    const clamped = Math.min(LAST_HOUR, Math.max(FIRST_HOUR, nowH));
    const target = (clamped - FIRST_HOUR) * PX_PER_HOUR;
    el.scrollTop = Math.max(0, target - el.clientHeight / 2);
  }, []);

  /** Snap a pointer y (within a day column) to a 30-minute slot. */
  const msAtY = (day: number, clientY: number): number => {
    const col = colRefs.current[day];
    if (!col) return day + 9 * 3600_000;
    const rect = col.getBoundingClientRect();
    const hours = (clientY - rect.top) / PX_PER_HOUR + FIRST_HOUR;
    const snapped = Math.round(hours * 2) / 2;
    return day + Math.min(LAST_HOUR, Math.max(FIRST_HOUR, snapped)) * 3600_000;
  };

  const beginSlotDrag = (day: number) => (ev: React.MouseEvent) => {
    if (ev.button !== 0) return;
    const from = msAtY(day, ev.clientY);
    setDrag({ day, from, to: from + 30 * 60_000 });
    const move = (e: MouseEvent) => {
      const to = msAtY(day, e.clientY);
      const next = to > from ? to : from + 30 * 60_000;
      // mousemove fires at pointer rate; only re-render on a new 30-min slot
      setDrag((d) => (d && d.to === next ? d : { day, from, to: next }));
    };
    const up = (e: MouseEvent) => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      setDrag(null);
      const to = msAtY(day, e.clientY);
      const start = Math.min(from, to);
      let end = Math.max(from, to);
      if (end - start < 30 * 60_000) end = start + 3600_000; // plain click = 1h
      useCalendar.getState().openCreate(start, end);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  const monthTitle = new Date(focusedDay).toLocaleDateString(undefined, {
    month: "long",
    year: "numeric",
  });
  const loading = days.some((d) => !loadedDays[d]);
  const nowTop =
    ((nowTick - today - FIRST_HOUR * 3600_000) / 3600_000) * PX_PER_HOUR;

  return (
    <div className="flex h-full min-w-0 flex-col">
      <div className="flex shrink-0 items-center gap-3 px-6 py-3">
        <span className="text-[20px] font-semibold tracking-tight text-ink">
          {monthTitle}
        </span>
        <button
          className="rounded-md border border-line px-2 py-0.5 text-ink-3 hover:bg-hover hover:text-ink"
          onClick={() => useCalendar.getState().shiftDay(-7)}
          title="Previous week"
        >
          ‹
        </button>
        <button
          className="rounded-md border border-line px-2 py-0.5 text-ink-3 hover:bg-hover hover:text-ink"
          onClick={() => useCalendar.getState().shiftDay(7)}
          title="Next week"
        >
          ›
        </button>
        <button
          className="rounded-md border border-line-strong px-2.5 py-0.5 text-[12px] text-ink-2 hover:bg-hover hover:text-ink"
          onClick={() => useCalendar.getState().goToday()}
        >
          Today
        </button>
        <button
          className="rounded-md bg-accent px-2.5 py-0.5 text-[12px] font-medium text-on-accent hover:opacity-90"
          onClick={() => {
            const start = focusedDay + 9 * 3600_000;
            useCalendar.getState().openCreate(start, start + 3600_000);
          }}
          title="New event (B)"
        >
          New event
        </button>
        {loading && (
          <span className="zb-spin inline-block h-3 w-3 rounded-full border-2 border-line-strong border-t-accent" />
        )}
        <div className="flex-1" />
        <span className="text-[11px] text-ink-3">
          <span className="kbd">←</span>/<span className="kbd">→</span> day ·{" "}
          <span className="kbd">Esc</span> back to mail
        </span>
      </div>

      {error ? (
        <div className="px-6 py-6 text-[12.5px] leading-relaxed text-ink-3">
          {error}
        </div>
      ) : (
        <>
          <div className="flex pl-14 pr-4">
            {days.map((d) => {
              const date = new Date(d);
              const isToday = d === today;
              const isFocused = d === focusedDay;
              return (
                <div
                  key={d}
                  className={`flex-1 rounded-t-md py-1.5 text-center text-[12.5px] ${
                    isFocused ? "bg-selected" : ""
                  } ${isToday ? "font-semibold text-ink" : "text-ink-3"}`}
                >
                  {date.toLocaleDateString(undefined, { weekday: "short" })}{" "}
                  {date.getDate()}
                </div>
              );
            })}
          </div>
          <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
            <div
              className="relative mb-3 ml-14 mr-4"
              style={{ height: (LAST_HOUR - FIRST_HOUR) * PX_PER_HOUR }}
            >
              {Array.from({ length: LAST_HOUR - FIRST_HOUR }, (_, i) => (
                <div
                  key={i}
                  className="absolute left-0 right-0 border-t border-line"
                  style={{ top: i * PX_PER_HOUR }}
                >
                  <span className="absolute -left-11 -top-2 text-[10.5px] text-ink-3">
                    {hourLabel(FIRST_HOUR + i)}
                  </span>
                </div>
              ))}
              <div className="absolute inset-0 flex">
                {days.map((d, i) => (
                  <div
                    key={d}
                    ref={(el) => {
                      colRefs.current[d] = el;
                    }}
                    className={`relative flex-1 cursor-crosshair ${i ? "border-l border-line" : ""} ${
                      d === today ? "bg-ok/5" : ""
                    } ${d === focusedDay ? "bg-selected/40" : ""}`}
                    onMouseDown={beginSlotDrag(d)}
                  >
                    {(eventsByDay[d] ?? [])
                      .filter((e) => !e.allDay)
                      .map((e) => (
                        <WeekEvent key={e.id} e={e} dayStart={d} />
                      ))}
                    {drag?.day === d && (
                      <div
                        className="pointer-events-none absolute left-0.5 right-0.5 rounded-[5px] border border-accent/60 bg-accent-dim/70"
                        style={{
                          top:
                            ((Math.min(drag.from, drag.to) - d - FIRST_HOUR * 3600_000) /
                              3600_000) *
                            PX_PER_HOUR,
                          height: Math.max(
                            (Math.abs(drag.to - drag.from) / 3600_000) * PX_PER_HOUR,
                            12
                          ),
                        }}
                      />
                    )}
                  </div>
                ))}
                {today >= weekStart &&
                  today < weekStart + 7 * DAY_MS &&
                  nowTop > 0 &&
                  nowTop < (LAST_HOUR - FIRST_HOUR) * PX_PER_HOUR && (
                    <div
                      className="pointer-events-none absolute border-t-2 border-bad"
                      style={{
                        top: nowTop,
                        left: `${(new Date(today).getDay() / 7) * 100}%`,
                        width: `${100 / 7}%`,
                      }}
                    >
                      <span className="absolute -left-[3px] -top-[4.5px] h-[7px] w-[7px] rounded-full bg-bad" />
                    </div>
                  )}
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
