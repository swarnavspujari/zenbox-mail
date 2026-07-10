import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { backend, openExternal } from "@/lib/ipc";
import { prepareEmailHtml } from "@/lib/email-render";
import { useMail } from "@/stores/mail";
import { useSettings } from "@/stores/settings";
import { useUi } from "@/stores/ui";
import { Avatar } from "@/components/Avatar";
import { ContactPanel } from "@/components/ContactPanel";
import { Label } from "@/components/Label";
import { InviteBar } from "@/features/thread/InviteBar";
import { ReplyDock } from "@/features/compose/ReplyDock";
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

// Injected into every message's shadow root. Theme tokens: CSS custom
// properties (and color-scheme) inherit THROUGH shadow boundaries, so the
// email restyles live on theme flips with no re-render. The email's own
// <style> rules are scoped to this shadow tree; app CSS can't reach in.
const EMAIL_SHADOW_CSS = `
  :host{display:block;background:var(--bg-raised,#ffffff);color:var(--text-primary,#1d222b);
        font:13.5px/1.55 "Segoe UI",system-ui,sans-serif;
        user-select:text;-webkit-user-select:text}
  /* Emails that style their own colors are authored against white; on the
     dark theme they'd go dark-on-dark, so designed mail gets a light canvas
     (Superhuman does the same). Bare mail keeps the theme canvas above. */
  :host([data-light-canvas]){background:#ffffff;color:#1d222b;color-scheme:light}
  :host([data-light-canvas]) a{color:#3b52c4}
  :host([data-light-canvas]) blockquote{border-left-color:#d5d9e2;color:#5b6272}
  #fm-pad{padding:16px 18px}
  /* Wide content (fixed-width tables, <pre>, oversized imgs) gets a
     horizontal scrollbar INSIDE the email box rather than widening the
     reading pane. #fm-root is its own scroll root, so this axis can never
     chain into the pane — no diagonal drift; y stays content-sized so the
     pane scrolls as one document. */
  #fm-root{overflow-x:auto;overflow-y:hidden;word-break:break-word}
  img{max-width:100%;height:auto}
  table{max-width:100%}
  a{color:var(--accent-strong,#3b52c4)}
  blockquote{margin:8px 0 8px 4px;padding-left:12px;border-left:2px solid var(--border-strong,#d5d9e2);color:var(--text-secondary,#5b6272)}
  pre{overflow-x:auto;max-width:100%}
  :host(:not([data-show-quote])) .gmail_quote,
  :host(:not([data-show-quote])) #fm-root>blockquote:last-of-type,
  :host(:not([data-show-quote])) div>blockquote:last-child{display:none!important}
`;

/**
 * Sanitized HTML body rendered inline in a shadow root, so the reading pane
 * is one continuous document: selection runs subject → body, one native
 * scroll spans the pane, and heights are real at first paint (no measuring,
 * no reflow when stepping between emails). Isolation model: the shadow root
 * scopes CSS both ways, and the wrapper div's `contain: layout paint style`
 * is a layout jail the email's CSS cannot reach (selectors can't cross the
 * boundary outward and :host rules are neutered in the sanitizer), so even
 * position:fixed content paints inside the message box. With the iframe
 * sandbox gone, the Rust sanitizer (mail/render.rs) is the sole trust
 * boundary for active content. Links open in the system browser; quoted
 * trails collapse behind the same ••• toggle as plain text.
 */
function HtmlBody({
  html,
  subject,
  showQuote,
}: {
  html: string;
  subject: string | null;
  showQuote: boolean;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const prepared = useMemo(
    () => prepareEmailHtml(html, { subject }),
    [html, subject]
  );
  // "Designed" mail declares its own colors or backgrounds somewhere;
  // bare mail (plain Gmail replies) declares neither.
  const ownColors = useMemo(
    () => /color\s*[:=]|background[^;:=]*[:=]/i.test(html),
    [html]
  );

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const root = host.shadowRoot ?? host.attachShadow({ mode: "open" });
    root.innerHTML = `<style>${EMAIL_SHADOW_CSS}</style><div id="fm-pad"><div id="fm-root">${prepared}</div></div>`;
    const open = (e: Event) => {
      const a = (e.target as Element | null)?.closest?.("a");
      if (!a) return;
      e.preventDefault(); // relative/#fragment links must never navigate the app
      const href = a.getAttribute("href");
      if (href && /^https?:|^mailto:/i.test(href)) void openExternal(href);
    };
    const aux = (e: Event) => {
      if ((e as MouseEvent).button === 1) open(e);
    };
    root.addEventListener("click", open);
    root.addEventListener("auxclick", aux);
    return () => {
      root.removeEventListener("click", open);
      root.removeEventListener("auxclick", aux);
    };
  }, [prepared]);

  return (
    <div
      style={{ contain: "layout paint style" }}
      className="rounded-b-[10px] bg-raised"
    >
      <div
        ref={hostRef}
        data-show-quote={showQuote ? "" : undefined}
        data-light-canvas={ownColors ? "" : undefined}
      />
    </div>
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
  first,
  last,
  onToggle,
}: {
  m: Message;
  expanded: boolean;
  first: boolean;
  last: boolean;
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
        className="flex w-full items-center gap-3 rounded-[10px] border border-line bg-surface px-4 py-2.5 text-left hover:bg-hover"
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
    <div
      className={`overflow-hidden rounded-[10px] border bg-raised ${
        last ? "border-line-strong" : "border-line"
      }`}
    >
      <button
        onClick={onToggle}
        className="flex w-full items-center gap-3 px-[18px] py-3 text-left"
      >
        <Avatar name={m.fromName} email={m.from} size={34} />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="font-semibold text-ink">{m.fromName}</span>
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
        <HtmlBody
          html={html}
          subject={first ? m.subject : null}
          showQuote={showQuote}
        />
      ) : isEmpty ? (
        <div className="flex items-center gap-2 px-[18px] py-3 text-[13px] italic text-ink-3">
          <span className="zb-spin inline-block h-3 w-3 rounded-full border-2 border-line-strong border-t-accent" />
          Loading message…
        </div>
      ) : (
        <div className="selectable whitespace-pre-wrap px-[18px] pb-4 pt-1 text-[14px] leading-[1.65] text-ink">
          {showQuote && quoted ? `${main}\n${quoted}` : main}
        </div>
      )}

      {hasQuoteToggle && (
        <div className="px-[18px] pb-3">
          <button
            onClick={() => setShowQuote((s) => !s)}
            className="rounded-full border border-line-strong px-2 leading-4 text-ink-3 hover:bg-hover"
            title={showQuote ? "Hide quoted text" : "Show quoted text"}
          >
            •••
          </button>
        </div>
      )}

      {m.attachments.length > 0 && (
        <div className="flex flex-wrap gap-2 border-t border-line px-[18px] py-3">
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
    <div className="border-t border-line bg-surface py-3">
      {/* Content aligns to the same centered 760px column as the email body
          above; the divider/background stay full-bleed across the pane. */}
      <div className="mx-auto w-full max-w-[760px] px-7">
        <div className="mb-2 flex items-center gap-2 text-[11px] uppercase tracking-[0.06em] text-ink-3">
          <span aria-hidden className="text-accent-strong">
            ✦
          </span>
          Instant replies — <span className="kbd">Tab</span> preview ·{" "}
          <span className="kbd">R</span> use
        </div>
        <div className="flex gap-2">
          {suggestions.map((s, i) => (
            <button
              key={i}
              onClick={() => {
                useUi.setState({ suggestionIndex: i });
              }}
              className={`max-w-[32%] truncate rounded-full border px-3.5 py-1.5 text-[12.5px] transition-colors ${
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
          <div className="zb-fade-in mt-2 whitespace-pre-wrap rounded-md border border-line bg-raised px-3 py-2 text-[13px] leading-relaxed text-ink">
            {suggestions[idx]}
          </div>
        )}
      </div>
    </div>
  );
}

export function ThreadView() {
  const messages = useMail((s) => s.openMessages);
  const threadId = useMail((s) => s.openThreadId);
  const myEmail = useSettings((s) => s.accounts.active);
  const compose = useUi((s) => s.compose);
  // A reply/forward for THIS thread docks its composer inline at the bottom
  // (new-message compose stays the modal); Instant Replies hide while it's open.
  const replyingHere =
    !!compose && compose.threadId === threadId && compose.mode !== "new";
  // Superhuman-style: older messages collapse; the last (and any unread)
  // stay open. User toggles override until the thread changes.
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});
  const scrollRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setOverrides({});
  }, [threadId]);

  useEffect(() => {
    // Bodies lay out at their real height before paint now (shadow DOM, no
    // iframe measurement lag), so position the pane deterministically: a
    // single message opens at the subject; a conversation jumps to the top
    // of the latest message (older ones sit collapsed above).
    const scroller = scrollRef.current;
    const last = listRef.current?.lastElementChild as HTMLElement | null;
    if (!scroller || !last) return;
    if (messages.length === 1) {
      scroller.scrollTop = 0;
      return;
    }
    const top =
      last.getBoundingClientRect().top -
      scroller.getBoundingClientRect().top +
      scroller.scrollTop;
    scroller.scrollTop = Math.max(0, top - 12);
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

  const thread = useMail((s) =>
    [...s.inbox, ...s.done, ...s.reminders, ...s.starred, ...s.trash].find(
      (t) => t.id === threadId
    )
  );

  if (messages.length === 0 || !threadId) return null;
  const subject = messages[0].subject;
  const isExpanded = (m: Message, i: number) =>
    overrides[m.id] ?? (i === messages.length - 1 || m.unread);
  // The person you're talking to: latest sender that isn't you.
  const me = (myEmail ?? "").toLowerCase();
  const contact =
    [...messages].reverse().find((m) => m.from.toLowerCase() !== me) ??
    messages[0];
  const userLabels = (thread?.labels ?? []).filter((l) => !/^[A-Z_]+$/.test(l));

  return (
    <div className="flex h-full min-w-0">
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex shrink-0 items-center gap-3 px-7 py-2.5">
          <button
            className="rounded px-1.5 py-0.5 text-ink-3 hover:bg-hover"
            onClick={() => useMail.getState().closeThread()}
            title="Back (Esc)"
          >
            ←
          </button>
          <div className="flex-1" />
          <span className="text-[11px] text-ink-3">
            <span className="kbd">E</span> done · <span className="kbd">R</span>{" "}
            reply · <span className="kbd">H</span> snooze
          </span>
        </div>
        <div
          ref={scrollRef}
          data-thread-scroll
          className="min-h-0 flex-1 overflow-y-auto"
        >
          <div className="mx-auto w-full max-w-[760px] px-7 pb-5">
            <div className="pb-4 pt-1">
              {userLabels.length > 0 && (
                <div className="mb-2 flex items-center gap-2">
                  {userLabels.map((l) => (
                    <Label key={l}>{l}</Label>
                  ))}
                </div>
              )}
              <h1 className="selectable text-[22px] font-semibold leading-snug tracking-tight text-ink">
                {subject}
              </h1>
              <div className="selectable mt-1 text-[12px] text-ink-3">
                {messages.length} message{messages.length > 1 ? "s" : ""}
              </div>
            </div>
            <InviteBar threadId={threadId} />
            <div ref={listRef} className="space-y-2">
              {messages.map((m, i) => (
                <MessageCard
                  key={m.id}
                  m={m}
                  expanded={isExpanded(m, i)}
                  first={i === 0}
                  last={i === messages.length - 1}
                  onToggle={() =>
                    setOverrides((o) => ({ ...o, [m.id]: !isExpanded(m, i) }))
                  }
                />
              ))}
            </div>
            {/* Threaded inline in the conversation column at the email's width. */}
            {replyingHere && <ReplyDock />}
          </div>
        </div>
        {!replyingHere && <InstantReplies />}
      </div>
      <ContactPanel
        name={contact.fromName}
        email={contact.from}
        currentThreadId={threadId}
      />
    </div>
  );
}
