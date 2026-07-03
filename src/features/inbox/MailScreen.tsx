import { useEffect, useMemo, useRef, useState } from "react";
import { backend } from "@/lib/ipc";
import { runCommandById } from "@/lib/commands";
import { splitThreads, useMail } from "@/stores/mail";
import { useSettings } from "@/stores/settings";
import { CalendarPanel } from "@/features/calendar/CalendarPanel";
import { FolderSidebar } from "@/components/FolderSidebar";
import { useUi } from "@/stores/ui";
import { IconButton } from "@/components/Button";
import { Label } from "@/components/Label";
import type { Thread } from "@/lib/types";

// Sender status dots — unread markers cycle so threads are tellable apart
// at a glance (design system "sender dots").
const DOTS = ["--dot-blue", "--dot-pink", "--dot-amber", "--dot-violet"];
function dotOf(key: string): string {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) | 0;
  return `var(${DOTS[((h % 4) + 4) % 4]})`;
}

function timeLabel(ms: number): string {
  const d = new Date(ms);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay)
    return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
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
      onClick={() => {
        const next = !open;
        void useSettings.getState().save({ calendarOpen: next });
        useUi.getState().setFocusRegion(next ? "calendar" : "mail");
      }}
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
    <div className="flex h-[52px] shrink-0 items-center gap-5 px-6">
      {shown.map((sp) => {
        const count = splitThreads(inbox, sp.id).length;
        const active = sp.id === activeSplitId;
        return (
          <button
            key={sp.id}
            onClick={() => useMail.getState().setActiveSplit(sp.id)}
            className={`flex items-center gap-2 py-1 text-[17px] tracking-tight transition-colors ${
              active ? "font-semibold text-ink" : "text-ink-3 hover:text-ink-2"
            }`}
          >
            {sp.name}
            {/* total conversations, not unread — a split reads like a to-do list */}
            <span
              className={`text-[12.5px] font-medium ${
                active ? "text-accent-strong" : "text-ink-3"
              }`}
            >
              {count}
            </span>
          </button>
        );
      })}
      <div className="flex-1" />
      <span className="whitespace-nowrap text-[11px] text-ink-3">
        <span className="kbd">Tab</span> to switch
      </span>
      <CalendarToggle />
    </div>
  );
}

function Row({
  t,
  index,
  selected,
  checked,
}: {
  t: Thread;
  index: number;
  selected: boolean;
  checked: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [hovered, setHovered] = useState(false);

  useEffect(() => {
    if (selected) ref.current?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  const userLabels = t.labels.filter((l) => !/^[A-Z_]+$/.test(l));

  return (
    <div
      ref={ref}
      onClick={(e) => {
        if (e.ctrlKey || e.metaKey) {
          useMail.getState().toggleSelected(t.id);
          return;
        }
        useMail.getState().select(index);
        void useMail.getState().openThread(t.id);
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className={`flex cursor-pointer items-center gap-3 px-6 py-[11px] text-[14px] ${
        selected ? "bg-selected" : checked ? "bg-accent-dim" : "hover:bg-hover"
      }`}
    >
      {checked ? (
        <div className="flex w-[7px] shrink-0 items-center justify-center text-[11px] leading-none text-accent-strong">
          ✓
        </div>
      ) : (
        <div
          className="h-[7px] w-[7px] shrink-0 rounded-full"
          style={{
            background: t.unread ? dotOf(t.participants[0] ?? t.id) : "transparent",
          }}
        />
      )}
      <div className="w-44 shrink-0 truncate">
        <span
          className={
            t.unread ? "font-semibold text-ink" : selected ? "text-ink-2" : "text-ink-2"
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
      <div className="flex min-w-0 flex-1 items-center gap-2 truncate">
        {userLabels.map((l) => (
          <Label key={l}>{l}</Label>
        ))}
        <span
          className={`shrink-0 ${t.unread ? "font-semibold text-ink" : "text-ink-2"}`}
        >
          {t.subject}
        </span>
        <span className="truncate text-[12.5px] text-ink-3">{t.snippet}</span>
      </div>
      {hovered ? (
        <div
          className="flex shrink-0 gap-0.5"
          onClick={(e) => e.stopPropagation()}
        >
          <IconButton
            label="Mark Done (E)"
            onClick={() => {
              useMail.getState().select(index);
              runCommandById("thread.done");
            }}
          >
            ✓
          </IconButton>
          <IconButton
            label="Remind me (H)"
            onClick={() => {
              useMail.getState().select(index);
              runCommandById("thread.snooze");
            }}
          >
            🕑
          </IconButton>
        </div>
      ) : (
        <>
          {t.snoozedUntil !== null && (
            <span className="shrink-0 rounded-full bg-accent-dim px-2 text-[11px] leading-[18px] text-accent-strong">
              {new Date(t.snoozedUntil).toLocaleString(undefined, {
                month: "short",
                day: "numeric",
                hour: "numeric",
                minute: "2-digit",
              })}
            </span>
          )}
          {t.starred && <span className="shrink-0 text-[12px] text-gold">★</span>}
          <span className="w-14 shrink-0 text-right text-[12px] text-ink-3">
            {timeLabel(t.lastDate)}
          </span>
        </>
      )}
    </div>
  );
}

function BulkBar({ count }: { count: number }) {
  return (
    <div className="zb-fade-in flex items-center gap-2 border-b border-line bg-accent-dim px-4 py-1.5 text-[12.5px] text-ink">
      <span className="font-medium">{count} selected</span>
      <div className="flex-1" />
      <button
        className="rounded-md border border-line-strong px-2.5 py-0.5 hover:bg-hover"
        onClick={() => runCommandById("thread.done")}
      >
        Mark Done <span className="kbd">E</span>
      </button>
      <button
        className="rounded-md border border-line-strong px-2.5 py-0.5 hover:bg-hover"
        onClick={() => runCommandById("thread.trash")}
      >
        Trash <span className="kbd">#</span>
      </button>
      <button
        className="rounded-md border border-line-strong px-2.5 py-0.5 hover:bg-hover"
        onClick={() => runCommandById("thread.move")}
      >
        Label <span className="kbd">V</span>
      </button>
      <button
        className="rounded-md px-2 py-0.5 text-ink-3 hover:bg-hover hover:text-ink"
        onClick={() => useMail.getState().clearSelection()}
        title="Clear selection (Esc)"
      >
        ×
      </button>
    </div>
  );
}

export function MailScreen() {
  const listView = useMail((s) => s.listView);
  const inbox = useMail((s) => s.inbox);
  const done = useMail((s) => s.done);
  const reminders = useMail((s) => s.reminders);
  const starred = useMail((s) => s.starred);
  const trash = useMail((s) => s.trash);
  const labelThreads = useMail((s) => s.labelThreads);
  const activeSplitId = useMail((s) => s.activeSplitId);
  const selectedIndex = useMail((s) => s.selectedIndex);
  const selectedIds = useMail((s) => s.selectedIds);
  const splits = useSettings((s) => s.settings.splits);
  const calendarOpen = useSettings((s) => s.settings.calendarOpen);
  const sidebarOpen = useSettings((s) => s.settings.sidebarOpen);
  const loaded = useMail((s) => s.loaded);

  const threads = useMemo(() => {
    if (listView === "inbox") return splitThreads(inbox, activeSplitId);
    if (listView === "done") return done;
    if (listView === "starred") return starred;
    if (listView === "trash") return trash;
    if (listView.startsWith("label:")) return labelThreads;
    return reminders;
    // splits is a dependency because splitThreads reads it via settings
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listView, inbox, done, reminders, starred, trash, labelThreads, activeSplitId, splits]);

  const title =
    listView === "inbox"
      ? null
      : listView === "done"
        ? "Done"
        : listView === "starred"
          ? "Starred"
          : listView === "trash"
            ? "Trash"
            : listView === "reminders"
              ? "Reminders"
              : listView.startsWith("label:")
                ? listView.slice(6)
                : listView;

  return (
    <div className="flex h-full">
      {sidebarOpen && <FolderSidebar />}
      <div
        className="flex min-w-0 flex-1 flex-col"
        onMouseDown={() => useUi.getState().setFocusRegion("mail")}
      >
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
        {selectedIds.size > 0 && <BulkBar count={selectedIds.size} />}
        <div className="min-h-0 flex-1 overflow-y-auto">
          {threads.map((t, i) => (
            <Row
              key={t.id}
              t={t}
              index={i}
              selected={i === selectedIndex}
              checked={selectedIds.has(t.id)}
            />
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
