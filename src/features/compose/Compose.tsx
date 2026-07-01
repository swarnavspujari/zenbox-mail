import { useEffect, useRef, useState } from "react";
import { backend } from "@/lib/ipc";
import { formatKeyExpr } from "@/lib/keyboard";
import { shortcutHint } from "@/lib/commands";
import { useMail } from "@/stores/mail";
import { useSettings } from "@/stores/settings";
import { useUi } from "@/stores/ui";

function splitAddresses(raw: string): string[] {
  return raw
    .split(/[,;]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** The Ctrl+J "Write with AI" instruction bar. */
function AiBar({
  getBody,
  setBody,
}: {
  getBody: () => string;
  setBody: (updater: (prev: string) => string) => void;
}) {
  const [instruction, setInstruction] = useState("");
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancelRef = useRef<(() => void) | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const compose = useUi((s) => s.compose);
  const provider = useSettings((s) => s.settings.defaultAiProvider);

  useEffect(() => {
    inputRef.current?.focus();
    return () => cancelRef.current?.();
  }, []);

  const go = () => {
    if (!instruction.trim() || running) return;
    setError(null);
    setRunning(true);
    const existing = getBody().trim();
    const isEdit = existing.length > 0;
    if (!isEdit) setBody(() => "");
    let received = "";
    cancelRef.current = backend.aiDraft(
      {
        threadId: compose?.threadId ?? null,
        instruction,
        existingText: isEdit ? existing : null,
        providerId: null, // default provider; per-request override lives in Settings
      },
      {
        onChunk: (c) => {
          received += c;
          if (isEdit) {
            // edits arrive as a full rewrite — replace once content flows
            setBody(() => received);
          } else {
            setBody((prev) => prev + c);
          }
        },
        onDone: () => {
          setRunning(false);
          setInstruction("");
        },
        onError: (e) => {
          setError(e);
          setRunning(false);
        },
      }
    );
  };

  return (
    <div className="border-t border-line bg-raised px-4 py-2.5">
      <div className="flex items-center gap-2">
        <span className="shrink-0 text-[12px] font-medium text-accent-strong">
          ✦ Write with AI
        </span>
        <input
          ref={inputRef}
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") go();
            if (e.key === "Escape") useUi.getState().setAiBarOpen(false);
          }}
          placeholder={
            getBody().trim()
              ? 'Edit instruction — e.g. "make it warmer", "tighten to 3 sentences"'
              : 'What should this say? e.g. "confirm the 15th works, ask about wiring details"'
          }
          className="min-w-0 flex-1 rounded-md border border-line-strong bg-surface px-3 py-1.5 text-[13px] text-ink placeholder:text-ink-3 focus:border-accent"
        />
        <button
          onClick={go}
          disabled={running}
          className="shrink-0 rounded-md bg-accent px-3 py-1.5 text-[12px] font-medium text-[#0e1014] hover:bg-accent-strong disabled:opacity-50"
        >
          {running ? "Drafting…" : "Draft"}
        </button>
      </div>
      <div className="mt-1 text-[11px] text-ink-3">
        Uses the full thread, attachments, and your Knowledge Base · provider:{" "}
        {provider}
        {error && <span className="ml-2 text-bad">{error}</span>}
      </div>
    </div>
  );
}

export function Compose() {
  const compose = useUi((s) => s.compose)!;
  const aiBarOpen = useUi((s) => s.aiBarOpen);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);

  const patch = (p: Partial<typeof compose>) =>
    useUi.setState((s) => ({ compose: s.compose ? { ...s.compose, ...p } : null }));

  useEffect(() => {
    bodyRef.current?.focus();
  }, []);

  useEffect(() => {
    const send = async () => {
      const c = useUi.getState().compose;
      if (!c || sending) return;
      const to = splitAddresses(c.to);
      if (to.length === 0) {
        setError("Add at least one recipient.");
        return;
      }
      setSending(true);
      setError(null);
      try {
        await backend.sendMail({
          threadId: c.threadId,
          to,
          cc: splitAddresses(c.cc),
          subject: c.subject || "(no subject)",
          bodyText: c.quote ? `${c.body}\n\n${c.quote}` : c.body,
          replyAll: c.mode === "replyAll",
        });
        useUi.getState().closeCompose();
        useUi.getState().showToast("Sent");
        await useMail.getState().refresh();
      } catch (e) {
        setError(String(e));
      } finally {
        setSending(false);
      }
    };
    const handler = () => void send();
    window.addEventListener("zenbox:send", handler);
    return () => window.removeEventListener("zenbox:send", handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sending]);

  const modeLabel =
    compose.mode === "new"
      ? "New message"
      : compose.mode === "reply"
        ? "Reply"
        : compose.mode === "replyAll"
          ? "Reply all"
          : "Forward";

  return (
    <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/50">
      <div className="zb-pop-in flex h-[80%] w-[760px] max-w-[94vw] flex-col rounded-xl border border-line-strong bg-overlay shadow-2xl">
        <div className="flex items-center gap-2 border-b border-line px-4 py-3">
          <span className="text-[13px] font-medium text-ink">{modeLabel}</span>
          <div className="flex-1" />
          <span className="text-[11px] text-ink-3">
            <span className="kbd">{formatKeyExpr(shortcutHint("compose.ai"))}</span>{" "}
            write with AI ·{" "}
            <span className="kbd">{formatKeyExpr(shortcutHint("compose.send"))}</span>{" "}
            send · <span className="kbd">Esc</span> discard
          </span>
        </div>

        <div className="flex items-center gap-2 border-b border-line px-4 py-2">
          <label className="w-8 text-[12px] text-ink-3">To</label>
          <input
            value={compose.to}
            onChange={(e) => patch({ to: e.target.value })}
            className="flex-1 bg-transparent text-[13px] text-ink outline-none placeholder:text-ink-3"
            placeholder="recipient@example.com"
          />
        </div>
        <div className="flex items-center gap-2 border-b border-line px-4 py-2">
          <label className="w-8 text-[12px] text-ink-3">Cc</label>
          <input
            value={compose.cc}
            onChange={(e) => patch({ cc: e.target.value })}
            className="flex-1 bg-transparent text-[13px] text-ink outline-none"
          />
        </div>
        <div className="flex items-center gap-2 border-b border-line px-4 py-2">
          <label className="w-8 text-[12px] text-ink-3">Subj</label>
          <input
            value={compose.subject}
            onChange={(e) => patch({ subject: e.target.value })}
            className="flex-1 bg-transparent text-[13px] font-medium text-ink outline-none"
            placeholder="Subject"
          />
        </div>

        <textarea
          ref={bodyRef}
          value={compose.body}
          onChange={(e) => patch({ body: e.target.value })}
          className="min-h-0 flex-1 resize-none bg-transparent px-4 py-3 text-[13.5px] leading-relaxed text-ink outline-none"
          placeholder="Write, or press Ctrl+J to draft with AI…"
        />

        {compose.quote && (
          <div className="max-h-28 overflow-y-auto border-t border-line px-4 py-2 text-[12px] leading-relaxed text-ink-3">
            {compose.quote}
          </div>
        )}

        {aiBarOpen && (
          <AiBar
            getBody={() => useUi.getState().compose?.body ?? ""}
            setBody={(updater) =>
              useUi.setState((s) => ({
                compose: s.compose
                  ? { ...s.compose, body: updater(s.compose.body) }
                  : null,
              }))
            }
          />
        )}

        <div className="flex items-center gap-3 border-t border-line px-4 py-3">
          <button
            onClick={() => window.dispatchEvent(new CustomEvent("zenbox:send"))}
            disabled={sending}
            className="rounded-md bg-accent px-4 py-1.5 text-[13px] font-medium text-[#0e1014] hover:bg-accent-strong disabled:opacity-50"
          >
            {sending ? "Sending…" : "Send"}
          </button>
          <button
            onClick={() => useUi.getState().closeCompose()}
            className="rounded-md px-3 py-1.5 text-[13px] text-ink-2 hover:bg-hover"
          >
            Discard
          </button>
          {error && <span className="text-[12px] text-bad">{error}</span>}
        </div>
      </div>
    </div>
  );
}
