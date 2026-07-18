// RSVP bar for invite mail: when the open thread carries an iCalendar invite
// (text/calendar part / .ics attachment), show the event summary with
// Accept / Tentative / Decline acting on the resolved Google Calendar copy.
// Unresolvable invites fall back to "Open in Google Calendar"; cancellations
// render an informational strip.
import { useEffect, useState } from "react";
import { backend, openExternal } from "@/lib/ipc";
import { useUi } from "@/stores/ui";
import type { RsvpResponse, ThreadId, ThreadInvite } from "@/lib/types";

const CHOICES: Array<{ value: RsvpResponse; label: string }> = [
  { value: "accepted", label: "Accept" },
  { value: "tentative", label: "Tentative" },
  { value: "declined", label: "Decline" },
];

function fmtWhen(
  startMs: number | null,
  endMs: number | null,
  allDay: boolean
): string | null {
  if (startMs === null) return null;
  const day = (ms: number) =>
    new Date(ms).toLocaleDateString(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric",
    });
  if (allDay) {
    // exclusive end → last included day
    const last = endMs !== null ? endMs - 1 : startMs;
    return day(last) === day(startMs)
      ? `${day(startMs)} · all day`
      : `${day(startMs)} – ${day(last)} · all day`;
  }
  const time = (ms: number) =>
    new Date(ms).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return endMs ? `${day(startMs)} · ${time(startMs)} – ${time(endMs)}` : `${day(startMs)} · ${time(startMs)}`;
}

// Session cache of invite detection per thread (null = "not an invite", the
// overwhelmingly common answer) so reopening never refires the lookup.
const inviteCache = new Map<ThreadId, ThreadInvite | null>();

export function InviteBar({ threadId }: { threadId: ThreadId }) {
  const [invite, setInvite] = useState<ThreadInvite | null>(
    () => inviteCache.get(threadId) ?? null
  );
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let stale = false;
    const cached = inviteCache.get(threadId);
    setInvite(cached ?? null);
    if (cached !== undefined) return; // cached (invite or confirmed non-invite)
    backend
      .threadInvite(threadId)
      .then((inv) => {
        inviteCache.set(threadId, inv);
        if (!stale) setInvite(inv);
      })
      .catch(() => {});
    return () => {
      stale = true;
    };
  }, [threadId]);

  if (!invite) return null;
  const ev = invite.event;
  const title = ev?.title ?? invite.summary ?? "Calendar invitation";
  const when = ev
    ? fmtWhen(ev.startMs, ev.endMs, ev.allDay)
    : fmtWhen(invite.startMs, invite.endMs, invite.allDay);
  const selfStatus = ev?.attendees.find((a) => a.self)?.responseStatus ?? null;

  if (invite.method === "CANCEL") {
    return (
      <div className="zb-fade-in mb-3 flex items-center gap-2.5 rounded-lg border border-line-strong bg-raised px-3.5 py-2.5 text-[12.5px] text-ink-2">
        <span>📅</span>
        <span className="min-w-0 flex-1 truncate">
          <span className="font-medium text-ink">{title}</span>
          {when ? ` · ${when}` : ""} — this event was cancelled by the organizer.
        </span>
      </div>
    );
  }

  const rsvp = async (response: RsvpResponse) => {
    if (!ev) return;
    setBusy(true);
    try {
      const updated = await backend.rsvpEvent(ev.calendarId, ev.id, response);
      inviteCache.set(threadId, { ...invite, event: updated });
      setInvite({ ...invite, event: updated });
      useUi.getState().showToast(
        response === "accepted"
          ? "Accepted — organizer notified"
          : response === "tentative"
            ? "Tentative — organizer notified"
            : "Declined — organizer notified"
      );
    } catch (e) {
      useUi.getState().showToast(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="zb-fade-in mb-3 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-accent/30 bg-accent-dim/60 px-3.5 py-2.5">
      <span>📅</span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] font-medium text-ink">{title}</div>
        <div className="truncate text-[11.5px] text-ink-3">
          {when}
          {invite.organizerEmail ? ` · ${invite.organizerEmail}` : ""}
        </div>
      </div>
      {ev ? (
        <div className="flex shrink-0 items-center gap-1.5">
          {CHOICES.map(({ value, label }) => (
            <button
              key={value}
              disabled={busy}
              onClick={() => void rsvp(value)}
              className={`rounded-md px-2.5 py-1 text-[12px] ${
                selfStatus === value
                  ? "bg-accent font-medium text-on-accent"
                  : "border border-line-strong text-ink-2 hover:bg-hover"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      ) : (
        <button
          className="shrink-0 rounded-md border border-line-strong px-2.5 py-1 text-[12px] text-ink-2 hover:bg-hover"
          onClick={() =>
            void openExternal(invite.openUrl ?? "https://calendar.google.com/")
          }
        >
          Open in Google Calendar
        </button>
      )}
    </div>
  );
}
