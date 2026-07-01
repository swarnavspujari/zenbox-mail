import { useEffect } from "react";
import { backend } from "@/lib/ipc";
import { useMail } from "@/stores/mail";
import { useUi } from "@/stores/ui";
import type { Message } from "@/lib/types";

function fmtSize(bytes: number): string {
  if (bytes > 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  if (bytes > 1_000) return `${Math.round(bytes / 1_000)} KB`;
  return `${bytes} B`;
}

function MessageCard({ m, last }: { m: Message; last: boolean }) {
  return (
    <div
      className={`rounded-lg border border-line bg-surface ${last ? "" : "opacity-90"}`}
    >
      <div className="flex items-baseline gap-2 border-b border-line px-4 py-2.5">
        <span className="font-medium text-ink">{m.fromName}</span>
        <span className="text-[12px] text-ink-3">{m.from}</span>
        <div className="flex-1" />
        <span className="text-[12px] text-ink-3">
          {new Date(m.date).toLocaleString()}
        </span>
      </div>
      <div className="px-4 py-2 text-[12px] text-ink-3">
        to {m.to.join(", ")}
        {m.cc.length > 0 && <> · cc {m.cc.join(", ")}</>}
      </div>
      <div className="selectable whitespace-pre-wrap px-4 pb-4 leading-relaxed text-ink">
        {m.bodyText}
      </div>
      {m.attachments.length > 0 && (
        <div className="flex flex-wrap gap-2 border-t border-line px-4 py-3">
          {m.attachments.map((a) => (
            <span
              key={a.id}
              className="flex items-center gap-2 rounded-md border border-line-strong bg-raised px-2.5 py-1.5 text-[12px] text-ink-2"
              title={a.mimeType}
            >
              📎 {a.filename}
              <span className="text-ink-3">{fmtSize(a.sizeBytes)}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function InstantReplies() {
  const suggestions = useUi((s) => s.suggestions);
  const idx = useUi((s) => s.suggestionIndex);

  if (suggestions.length === 0) return null;
  return (
    <div className="border-t border-line bg-surface px-6 py-3">
      <div className="mb-2 text-[11px] uppercase tracking-wide text-ink-3">
        Instant replies — <span className="kbd">Tab</span> to preview,{" "}
        <span className="kbd">R</span> to use
      </div>
      <div className="flex gap-2">
        {suggestions.map((s, i) => (
          <button
            key={i}
            onClick={() => {
              useUi.setState({ suggestionIndex: i });
            }}
            className={`max-w-[32%] truncate rounded-full border px-3 py-1.5 text-[12px] transition-colors ${
              idx === i
                ? "border-accent bg-accent-dim text-ink"
                : "border-line-strong bg-raised text-ink-2 hover:bg-hover"
            }`}
          >
            {s}
          </button>
        ))}
      </div>
      {idx !== null && (
        <div className="zb-fade-in mt-2 whitespace-pre-wrap rounded-md border border-line bg-raised px-3 py-2 text-[13px] text-ink">
          {suggestions[idx]}
        </div>
      )}
    </div>
  );
}

export function ThreadView() {
  const messages = useMail((s) => s.openMessages);
  const threadId = useMail((s) => s.openThreadId);

  // Fetch instant-reply suggestions for the open thread.
  useEffect(() => {
    useUi.getState().setSuggestions([]);
    if (!threadId) return;
    let stale = false;
    backend
      .aiSuggestReplies(threadId)
      .then((s) => {
        if (!stale) useUi.getState().setSuggestions(s.slice(0, 3));
      })
      .catch(() => {
        /* no provider key yet — instant replies simply don't appear */
      });
    return () => {
      stale = true;
    };
  }, [threadId]);

  if (messages.length === 0) return null;
  const subject = messages[0].subject;

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-3 border-b border-line bg-surface px-6 py-3">
        <button
          className="rounded px-1.5 py-0.5 text-ink-3 hover:bg-hover"
          onClick={() => useMail.getState().closeThread()}
          title="Back (Esc)"
        >
          ←
        </button>
        <h1 className="truncate text-[15px] font-semibold text-ink">{subject}</h1>
        <div className="flex-1" />
        <span className="text-[11px] text-ink-3">
          <span className="kbd">E</span> done · <span className="kbd">R</span>{" "}
          reply · <span className="kbd">H</span> snooze
        </span>
      </div>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-6 py-4">
        {messages.map((m, i) => (
          <MessageCard key={m.id} m={m} last={i === messages.length - 1} />
        ))}
      </div>
      <InstantReplies />
    </div>
  );
}
