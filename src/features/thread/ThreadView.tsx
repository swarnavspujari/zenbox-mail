import { useEffect, useMemo, useRef, useState } from "react";
import { backend, isTauri } from "@/lib/ipc";
import { useMail } from "@/stores/mail";
import { useUi } from "@/stores/ui";
import { Avatar } from "@/components/Avatar";
import type { Attachment, Message } from "@/lib/types";

function fmtSize(bytes: number): string {
  if (bytes > 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  if (bytes > 1_000) return `${Math.round(bytes / 1_000)} KB`;
  return `${bytes} B`;
}

function fmtWhen(ms: number): string {
  const d = new Date(ms);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay)
    return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

async function openExternal(url: string) {
  if (isTauri) {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(url);
  } else {
    window.open(url, "_blank", "noopener");
  }
}

/** Split plain text into the fresh part and the quoted trail. */
function splitQuotedText(text: string): { main: string; quoted: string | null } {
  const lines = text.split("\n");
  for (let i = 1; i < lines.length; i++) {
    const l = lines[i].trim();
    const restAllQuoted = () =>
      lines.slice(i).every((x) => x.trim() === "" || x.trim().startsWith(">"));
    if (/^On .{8,100} wrote:$/.test(l) || (l.startsWith(">") && restAllQuoted())) {
      const main = lines.slice(0, i).join("\n").trimEnd();
      if (!main) return { main: text, quoted: null };
      return { main, quoted: lines.slice(i).join("\n") };
    }
  }
  return { main: text, quoted: null };
}

const QUOTE_MARKERS = ["gmail_quote", "<blockquote"];

/**
 * Sanitized HTML body in a script-less sandboxed iframe. Height tracks the
 * content; links open in the system browser; quoted trails collapse behind
 * the same ••• toggle as plain text.
 */
function HtmlBody({ html, showQuote }: { html: string; showQuote: boolean }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(80);

  const srcDoc = useMemo(() => {
    const quoteCss = showQuote
      ? ""
      : ".gmail_quote{display:none!important} body>blockquote:last-of-type, div>blockquote:last-child{display:none!important}";
    return `<!doctype html><html><head><meta charset="utf-8"><style>
      html,body{margin:0;padding:0}
      body{background:#ffffff;color:#1d222b;font:13.5px/1.55 "Segoe UI",system-ui,sans-serif;
           padding:16px 18px;word-break:break-word;overflow-x:hidden}
      img{max-width:100%;height:auto}
      table{max-width:100%}
      a{color:#3b52c4}
      blockquote{margin:8px 0 8px 4px;padding-left:12px;border-left:2px solid #d5d9e2;color:#5b6272}
      pre{white-space:pre-wrap}
      ${quoteCss}
    </style></head><body>${html}</body></html>`;
  }, [html, showQuote]);

  useEffect(() => {
    const iframe = ref.current;
    if (!iframe) return;
    let ro: ResizeObserver | null = null;
    const wire = () => {
      const doc = iframe.contentDocument;
      if (!doc?.body) return;
      // body.scrollHeight, not documentElement's — the latter never reports
      // smaller than the iframe viewport, so heights would only ratchet up
      const measure = () =>
        setHeight(Math.min(20_000, Math.max(40, doc.body.scrollHeight)));
      measure();
      ro = new ResizeObserver(measure);
      ro.observe(doc.body);
      // late-loading remote images change the layout
      for (const img of Array.from(doc.images)) {
        img.addEventListener("load", measure);
      }
      doc.addEventListener("click", (e) => {
        const a = (e.target as Element | null)?.closest?.("a");
        if (a?.getAttribute("href")) {
          e.preventDefault();
          const href = a.getAttribute("href")!;
          if (/^https?:|^mailto:/.test(href)) void openExternal(href);
        }
      });
    };
    iframe.addEventListener("load", wire);
    wire();
    return () => {
      iframe.removeEventListener("load", wire);
      ro?.disconnect();
    };
  }, [srcDoc]);

  return (
    <iframe
      ref={ref}
      sandbox="allow-same-origin"
      srcDoc={srcDoc}
      title="message"
      className="w-full rounded-b-lg border-0 bg-white"
      style={{ height }}
    />
  );
}

function AttachmentChip({ a }: { a: Attachment }) {
  const [busy, setBusy] = useState(false);
  const act = async (mode: "open" | "save") => {
    if (busy) return;
    setBusy(true);
    try {
      if (mode === "open") {
        await backend.openAttachment(a.id);
      } else {
        const path = await backend.downloadAttachment(a.id);
        if (path) useUi.getState().showToast(`Saved ${path}`);
      }
    } catch (e) {
      useUi.getState().showToast(String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <span
      className="flex items-center gap-1 rounded-md border border-line-strong bg-raised py-1 pl-2.5 pr-1 text-[12px] text-ink-2"
      title={`${a.mimeType} · ${fmtSize(a.sizeBytes)}`}
    >
      <button
        onClick={() => void act("open")}
        disabled={busy}
        className="hover:text-ink disabled:opacity-50"
        title="Open"
      >
        📎 {a.filename}
        <span className="ml-1.5 text-ink-3">{fmtSize(a.sizeBytes)}</span>
      </button>
      <button
        onClick={() => void act("save")}
        disabled={busy}
        className="rounded px-1.5 py-0.5 text-ink-3 hover:bg-hover hover:text-ink disabled:opacity-50"
        title="Save as…"
      >
        ⭳
      </button>
    </span>
  );
}

function MessageCard({
  m,
  expanded,
  onToggle,
}: {
  m: Message;
  expanded: boolean;
  onToggle: () => void;
}) {
  const [showQuote, setShowQuote] = useState(false);
  const { main, quoted } = useMemo(() => splitQuotedText(m.bodyText), [m.bodyText]);
  const html = m.bodyHtml;
  const htmlHasQuote = html !== null && QUOTE_MARKERS.some((q) => html.includes(q));
  const hasQuoteToggle = html ? htmlHasQuote : quoted !== null;
  // No HTML and no text = a body that didn't come through on first sync;
  // openThread refetches it in the background (see stores/mail openThread).
  const isEmpty = !html && !m.bodyText.trim();

  if (!expanded) {
    return (
      <button
        onClick={onToggle}
        className="flex w-full items-center gap-3 rounded-lg border border-line bg-surface px-4 py-2.5 text-left hover:bg-hover"
      >
        <Avatar name={m.fromName} email={m.from} size={26} />
        <span className="w-40 shrink-0 truncate text-[13px] font-medium text-ink-2">
          {m.fromName}
        </span>
        <span className="min-w-0 flex-1 truncate text-[12.5px] text-ink-3">
          {m.snippet || m.bodyText.slice(0, 120)}
        </span>
        <span className="shrink-0 text-[11.5px] text-ink-3">{fmtWhen(m.date)}</span>
      </button>
    );
  }

  return (
    <div className="overflow-hidden rounded-lg border border-line bg-surface">
      <button
        onClick={onToggle}
        className="flex w-full items-center gap-3 border-b border-line px-4 py-2.5 text-left"
      >
        <Avatar name={m.fromName} email={m.from} size={32} />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="font-medium text-ink">{m.fromName}</span>
            <span className="truncate text-[12px] text-ink-3">{m.from}</span>
          </div>
          <div className="truncate text-[12px] text-ink-3">
            to {m.to.join(", ")}
            {m.cc.length > 0 && <> · cc {m.cc.join(", ")}</>}
          </div>
        </div>
        <span className="shrink-0 text-[12px] text-ink-3">{fmtWhen(m.date)}</span>
      </button>

      {html ? (
        <HtmlBody html={html} showQuote={showQuote} />
      ) : isEmpty ? (
        <div className="flex items-center gap-2 px-4 py-3 text-[13px] italic text-ink-3">
          <span className="zb-spin inline-block h-3 w-3 rounded-full border-2 border-line-strong border-t-accent" />
          Loading message…
        </div>
      ) : (
        <div className="selectable whitespace-pre-wrap px-4 py-3 leading-relaxed text-ink">
          {showQuote && quoted ? `${main}\n${quoted}` : main}
        </div>
      )}

      {hasQuoteToggle && (
        <div className={html ? "bg-white px-4 pb-3" : "px-4 pb-2"}>
          <button
            onClick={() => setShowQuote((s) => !s)}
            className={`rounded-full border px-2 leading-4 ${
              html
                ? "border-neutral-300 text-neutral-500 hover:bg-neutral-100"
                : "border-line-strong text-ink-3 hover:bg-hover"
            }`}
            title={showQuote ? "Hide quoted text" : "Show quoted text"}
          >
            •••
          </button>
        </div>
      )}

      {m.attachments.length > 0 && (
        <div className="flex flex-wrap gap-2 border-t border-line px-4 py-3">
          {m.attachments.map((a) => (
            <AttachmentChip key={a.id} a={a} />
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
  // Superhuman-style: older messages collapse; the last (and any unread)
  // stay open. User toggles override until the thread changes.
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setOverrides({});
  }, [threadId]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [threadId, messages.length]);

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
  const isExpanded = (m: Message, i: number) =>
    overrides[m.id] ?? (i === messages.length - 1 || m.unread);

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
        <span className="shrink-0 rounded-full bg-raised px-2 text-[11px] leading-[18px] text-ink-3">
          {messages.length}
        </span>
        <div className="flex-1" />
        <span className="text-[11px] text-ink-3">
          <span className="kbd">E</span> done · <span className="kbd">R</span>{" "}
          reply · <span className="kbd">H</span> snooze
        </span>
      </div>
      <div
        data-thread-scroll
        className="min-h-0 flex-1 space-y-2 overflow-y-auto px-6 py-4"
      >
        {messages.map((m, i) => (
          <MessageCard
            key={m.id}
            m={m}
            expanded={isExpanded(m, i)}
            onToggle={() =>
              setOverrides((o) => ({ ...o, [m.id]: !isExpanded(m, i) }))
            }
          />
        ))}
        <div ref={endRef} />
      </div>
      <InstantReplies />
    </div>
  );
}
