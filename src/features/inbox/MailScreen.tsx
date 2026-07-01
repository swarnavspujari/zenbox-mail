import { useEffect, useMemo, useRef } from "react";
import { splitThreads, useMail } from "@/stores/mail";
import { useSettings } from "@/stores/settings";
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

function SplitTabs() {
  const inbox = useMail((s) => s.inbox);
  const activeSplitId = useMail((s) => s.activeSplitId);
  const splits = useSettings((s) => s.settings.splits);

  const shown = splits.filter(
    (sp) => !sp.hideWhenEmpty || splitThreads(inbox, sp.id).length > 0
  );

  return (
    <div className="flex items-center gap-1 border-b border-line bg-surface px-3">
      {shown.map((sp) => {
        const count = splitThreads(inbox, sp.id).length;
        const active = sp.id === activeSplitId;
        return (
          <button
            key={sp.id}
            onClick={() => useMail.getState().setActiveSplit(sp.id)}
            className={`relative -mb-px flex items-center gap-2 border-b-2 px-3 py-2 text-[13px] transition-colors ${
              active
                ? "border-accent text-ink"
                : "border-transparent text-ink-3 hover:text-ink-2"
            }`}
          >
            {sp.name}
            {/* total conversations, not unread — a split reads like a to-do list */}
            <span
              className={`rounded-full px-1.5 text-[11px] leading-[18px] ${
                active ? "bg-accent-dim text-accent-strong" : "bg-raised text-ink-3"
              }`}
            >
              {count}
            </span>
          </button>
        );
      })}
      <div className="flex-1" />
      <span className="pr-1 text-[11px] text-ink-3">
        <span className="kbd">Tab</span> to switch
      </span>
    </div>
  );
}

function Row({ t, index }: { t: Thread; index: number }) {
  const selected = useMail((s) => s.selectedIndex === index);
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
      className={`flex cursor-pointer items-center gap-3 border-b border-line px-4 py-2.5 ${
        selected ? "bg-selected" : "hover:bg-hover"
      }`}
    >
      <div
        className={`h-1.5 w-1.5 shrink-0 rounded-full ${
          t.unread ? "bg-accent-strong" : "bg-transparent"
        }`}
      />
      <div className="w-44 shrink-0 truncate">
        <span className={t.unread ? "font-semibold text-ink" : "text-ink-2"}>
          {t.participants
            .map((p) => p.replace(/\s*<[^>]*>/, ""))
            .slice(0, 2)
            .join(", ")}
        </span>
        {t.messageCount > 1 && (
          <span className="ml-1 text-[11px] text-ink-3">{t.messageCount}</span>
        )}
      </div>
      <div className="min-w-0 flex-1 truncate">
        <span className={t.unread ? "font-medium text-ink" : "text-ink-2"}>
          {t.subject}
        </span>
        <span className="ml-2 text-[12px] text-ink-3">{t.snippet}</span>
      </div>
      {t.starred && <span className="shrink-0 text-[12px] text-warn">★</span>}
      {t.snoozedUntil !== null && (
        <span className="shrink-0 rounded bg-accent-dim px-1.5 text-[11px] text-accent-strong">
          {new Date(t.snoozedUntil).toLocaleString(undefined, {
            month: "short",
            day: "numeric",
            hour: "numeric",
            minute: "2-digit",
          })}
        </span>
      )}
      <span className="w-14 shrink-0 text-right text-[12px] text-ink-3">
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
  const activeSplitId = useMail((s) => s.activeSplitId);
  const splits = useSettings((s) => s.settings.splits);
  const loaded = useMail((s) => s.loaded);

  const threads = useMemo(() => {
    if (listView === "inbox") return splitThreads(inbox, activeSplitId);
    return listView === "done" ? done : reminders;
    // splits is a dependency because splitThreads reads it via settings
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listView, inbox, done, reminders, activeSplitId, splits]);

  const title =
    listView === "inbox" ? null : listView === "done" ? "Done" : "Reminders";

  return (
    <div className="flex h-full flex-col">
      {listView === "inbox" ? (
        <SplitTabs />
      ) : (
        <div className="border-b border-line bg-surface px-4 py-2 text-[13px] font-medium text-ink">
          {title}
          <span className="ml-2 rounded-full bg-raised px-1.5 text-[11px] text-ink-3">
            {threads.length}
          </span>
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {threads.map((t, i) => (
          <Row key={t.id} t={t} index={i} />
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
  );
}
