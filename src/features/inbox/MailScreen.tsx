import { useEffect, useMemo, useRef, useState } from "react";
import { backend } from "@/lib/ipc";
import { splitThreads, useMail } from "@/stores/mail";
import { useSettings } from "@/stores/settings";
import { CalendarPanel } from "@/features/calendar/CalendarPanel";
import type { Thread } from "@/lib/types";

function timeLabel(ms: number): string {
  const d = new Date(ms);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay)
    return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const days = (now.getTime() - ms) / 86_400_000;
  if (days < 7) return d.toLocaleDateString(undefined, { weekday: "short" });
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** Toggle for the day panel; the badge counts what's still ahead today. */
function CalendarToggle() {
  const open = useSettings((s) => s.settings.calendarOpen);
  const [upcoming, setUpcoming] = useState<number | null>(null);

  // Only hit Google when the panel is open — this component is always mounted,
  // and an eager listEvents on every MailScreen mount was a per-navigation
  // network round-trip (and a repeated failure when Calendar isn't configured).
  useEffect(() => {
    if (!open) {
      setUpcoming(null);
      return;
    }
    const dayStart = new Date().setHours(0, 0, 0, 0);
    backend
      .listEvents(dayStart, dayStart + 86_400_000)
      .then((ev) => setUpcoming(ev.filter((e) => e.endMs > Date.now()).length))
      .catch(() => setUpcoming(null));
  }, [open]);

  return (
    <button
      onClick={() => void useSettings.getState().save({ calendarOpen: !open })}
      className={`flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-[12px] transition-colors ${
        open
          ? "border-accent/50 bg-accent-dim text-ink"
          : "border-line text-ink-3 hover:border-line-strong hover:text-ink-2"
      }`}
      title="Toggle the calendar panel"
    >
      <span aria-hidden>▦</span> Calendar
      {upcoming !== null && upcoming > 0 && (
        <span
          className={`rounded-full px-1.5 text-[10.5px] leading-[16px] ${
            open ? "bg-accent text-on-accent" : "bg-raised text-ink-3"
          }`}
        >
          {upcoming}
        </span>
      )}
    </button>
  );
}

function SplitTabs() {
  const inbox = useMail((s) => s.inbox);
  const activeSplitId = useMail((s) => s.activeSplitId);
  const splits = useSettings((s) => s.settings.splits);

  const shown = splits.filter(
    (sp) => !sp.hideWhenEmpty || splitThreads(inbox, sp.id).length > 0
  );

  return (
    <div className="flex items-center gap-1 border-b border-line bg-base px-3">
      {shown.map((sp) => {
        const count = splitThreads(inbox, sp.id).length;
        const active = sp.id === activeSplitId;
        return (
          <button
            key={sp.id}
            onClick={() => useMail.getState().setActiveSplit(sp.id)}
            className={`relative -mb-px flex items-center gap-2 border-b-2 px-3 py-2.5 text-[13px] transition-colors ${
              active
                ? "border-accent font-medium text-ink"
                : "border-transparent text-ink-3 hover:text-ink-2"
            }`}
          >
            {sp.name}
            {/* total conversations, not unread — a split reads like a to-do list */}
            <span
              className={`rounded-full border px-1.5 text-[10.5px] leading-[17px] ${
                active
                  ? "border-accent/40 bg-accent-dim text-accent-strong"
                  : "border-line bg-raised text-ink-3"
              }`}
            >
              {count}
            </span>
          </button>
        );
      })}
      <div className="flex-1" />
      <span className="pr-2 text-[11px] text-ink-3">
        <span className="kbd">Tab</span> to switch
      </span>
      <div className="pb-1.5 pt-1">
        <CalendarToggle />
      </div>
    </div>
  );
}

function Row({
  t,
  index,
  selected,
}: {
  t: Thread;
  index: number;
  selected: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (selected) ref.current?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  return (
    <div
      ref={ref}
      onClick={() => {
        useMail.getState().select(index);
        void useMail.getState().openThread(t.id);
      }}
      className={`flex cursor-pointer items-center gap-3 border-b border-line px-4 py-[10px] ${
        selected ? "bg-selected" : "hover:bg-hover"
      }`}
    >
      <div
        className={`h-1.5 w-1.5 shrink-0 rounded-full ${
          t.unread ? "bg-accent-strong" : "bg-transparent"
        }`}
      />
      <div className="w-44 shrink-0 truncate">
        <span
          className={
            t.unread ? "font-semibold text-ink" : selected ? "text-ink-2" : "text-ink-3"
          }
        >
          {t.participants
            .map((p) => p.replace(/\s*<[^>]*>/, ""))
            .slice(0, 2)
            .join(", ")}
        </span>
        {t.messageCount > 1 && (
          <span className="ml-1.5 text-[11px] text-ink-3">{t.messageCount}</span>
        )}
      </div>
      <div className="min-w-0 flex-1 truncate">
        <span className={t.unread ? "font-semibold text-ink" : "text-ink-2"}>
          {t.subject}
        </span>
        <span className="ml-2 text-[12px] text-ink-3">{t.snippet}</span>
      </div>
      {t.snoozedUntil !== null && (
        <span className="shrink-0 rounded bg-accent-dim px-1.5 text-[11px] leading-[18px] text-accent-strong">
          {new Date(t.snoozedUntil).toLocaleString(undefined, {
            month: "short",
            day: "numeric",
            hour: "numeric",
            minute: "2-digit",
          })}
        </span>
      )}
      {t.starred && <span className="shrink-0 text-[12px] text-warn">★</span>}
      <span className="w-14 shrink-0 text-right text-[11.5px] text-ink-3">
        {timeLabel(t.lastDate)}
      </span>
    </div>
  );
}

export function MailScreen() {
  const listView = useMail((s) => s.listView);
  const inbox = useMail((s) => s.inbox);
  const done = useMail((s) => s.done);
  const reminders = useMail((s) => s.reminders);
  const starred = useMail((s) => s.starred);
  const activeSplitId = useMail((s) => s.activeSplitId);
  const selectedIndex = useMail((s) => s.selectedIndex);
  const splits = useSettings((s) => s.settings.splits);
  const calendarOpen = useSettings((s) => s.settings.calendarOpen);
  const loaded = useMail((s) => s.loaded);

  const threads = useMemo(() => {
    if (listView === "inbox") return splitThreads(inbox, activeSplitId);
    if (listView === "done") return done;
    if (listView === "starred") return starred;
    return reminders;
    // splits is a dependency because splitThreads reads it via settings
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listView, inbox, done, reminders, starred, activeSplitId, splits]);

  const title =
    listView === "inbox"
      ? null
      : listView === "done"
        ? "Done"
        : listView === "starred"
          ? "Starred"
          : "Reminders";

  return (
    <div className="flex h-full">
      <div className="flex min-w-0 flex-1 flex-col">
        {listView === "inbox" ? (
          <SplitTabs />
        ) : (
          <div className="flex items-center border-b border-line bg-base px-4 py-2 text-[13px] font-medium text-ink">
            {title}
            <span className="ml-2 rounded-full border border-line bg-raised px-1.5 text-[10.5px] leading-[17px] text-ink-3">
              {threads.length}
            </span>
            <div className="flex-1" />
            <CalendarToggle />
          </div>
        )}
        <div className="min-h-0 flex-1 overflow-y-auto">
          {threads.map((t, i) => (
            <Row key={t.id} t={t} index={i} selected={i === selectedIndex} />
          ))}
          {loaded && threads.length === 0 && (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-ink-3">
              <div className="text-4xl">◎</div>
              <div className="text-[14px]">
                {listView === "inbox" ? "This split is at zero." : "Nothing here."}
              </div>
              {listView === "inbox" && (
                <div className="text-[12px]">
                  Breathe. Or press <span className="kbd">Tab</span> for the next
                  split.
                </div>
              )}
            </div>
          )}
        </div>
      </div>
      {calendarOpen && <CalendarPanel />}
    </div>
  );
}
