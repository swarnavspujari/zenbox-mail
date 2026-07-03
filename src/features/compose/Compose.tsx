import { useEffect, useRef, useState } from "react";
import { backend } from "@/lib/ipc";
import { formatKeyExpr } from "@/lib/keyboard";
import { pushTriageUndo, shortcutHint } from "@/lib/commands";
import { pushUndo } from "@/lib/undo";
import { useMail } from "@/stores/mail";
import { useSettings } from "@/stores/settings";
import { outgoingFromCompose, useUi } from "@/stores/ui";
import { sanitizeUserHtml } from "@/lib/sanitize";
import type { MailAttachment } from "@/lib/types";

const UNDO_SEND_MS = 10_000;
const MAX_ATTACH_TOTAL = 25_000_000; // Gmail's raw-message ceiling

function splitAddresses(raw: string): string[] {
  return raw
    .split(/[,;]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function fmtSize(bytes: number): string {
  if (bytes > 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  if (bytes > 1_000) return `${Math.round(bytes / 1_000)} KB`;
  return `${bytes} B`;
}

function readFileB64(file: File): Promise<MailAttachment> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onerror = () => reject(new Error(`could not read ${file.name}`));
    r.onload = () => {
      const url = String(r.result); // data:<mime>;base64,<data>
      resolve({
        filename: file.name,
        mimeType: file.type || "application/octet-stream",
        dataBase64: url.slice(url.indexOf(",") + 1),
      });
    };
    r.readAsDataURL(file);
  });
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
          className="shrink-0 rounded-md bg-accent px-3 py-1.5 text-[12px] font-medium text-on-accent hover:bg-accent-strong disabled:opacity-50"
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
  const fileRef = useRef<HTMLInputElement>(null);

  const patch = (p: Partial<typeof compose>) =>
    useUi.setState((s) => ({ compose: s.compose ? { ...s.compose, ...p } : null }));

  useEffect(() => {
    bodyRef.current?.focus();
  }, []);

  // Autosave the draft while typing, so a crash or close loses nothing.
  useEffect(() => {
    const t = setTimeout(() => {
      const c = useUi.getState().compose;
      if (!c) return;
      const hasContent =
        !!(c.to.trim() || c.subject.trim() || c.body.trim()) ||
        c.attachments.length > 0;
      if (!hasContent) return;
      const { draftId, ...payload } = c;
      void backend
        .saveDraft(draftId, JSON.stringify(payload))
        .then((id) => {
          const cur = useUi.getState().compose;
          if (cur && cur.draftId !== id) {
            useUi.setState((s) => ({
              compose: s.compose ? { ...s.compose, draftId: id } : null,
            }));
          }
        })
        .catch(() => {});
    }, 800);
    return () => clearTimeout(t);
  }, [compose.to, compose.cc, compose.subject, compose.body, compose.attachments]);

  const addFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    const current = useUi.getState().compose;
    if (!current) return;
    const existing = current.attachments.reduce(
      (n, a) => n + a.dataBase64.length * 0.75,
      0
    );
    let total = existing;
    const added: MailAttachment[] = [];
    for (const f of Array.from(files)) {
      total += f.size;
      if (total > MAX_ATTACH_TOTAL) {
        setError("Attachments exceed the 25 MB limit.");
        break;
      }
      added.push(await readFileB64(f));
    }
    if (added.length) {
      patch({ attachments: [...current.attachments, ...added] });
    }
  };

  useEffect(() => {
    const send = async (markDone: boolean) => {
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
        // Queue with a 10s fuse instead of sending immediately — that fuse
        // IS the Undo Send window (Z pulls the draft back).
        const outboxId = await backend.queueMail(outgoingFromCompose(c), UNDO_SEND_MS);
        if (c.draftId !== null) void backend.deleteDraft(c.draftId).catch(() => {});
        const saved = { ...c, draftId: null };
        useUi.getState().closeCompose();
        pushUndo({
          label: "Send",
          expiresAt: Date.now() + UNDO_SEND_MS - 1_000,
          run: async () => {
            try {
              await backend.cancelOutbox(outboxId);
              useUi.getState().startCompose(saved);
              useUi.getState().showToast("Send undone — draft restored");
            } catch {
              useUi.getState().showToast("Too late — already sent");
            }
          },
        });
        if (markDone && c.threadId) {
          if (useMail.getState().openThreadId === c.threadId)
            useMail.getState().closeThread();
          const tid = c.threadId;
          await useMail.getState().archive(tid);
          pushTriageUndo("Mark Done", () => useMail.getState().moveToInbox(tid));
          useUi.getState().showToast("Sent & marked done — Z to undo");
          await useUi.getState().checkInboxZero();
        } else {
          useUi.getState().showToast("Sent — Z to undo");
        }
        await useMail.getState().refresh();
      } catch (e) {
        setError(String(e));
      } finally {
        setSending(false);
      }
    };
    const handler = (e: Event) =>
      void send(Boolean((e as CustomEvent).detail?.markDone));
    window.addEventListener("fission:send", handler);
    return () => window.removeEventListener("fission:send", handler);
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
            send · <span className="kbd">Esc</span> saves draft
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

        {compose.attachments.length > 0 && (
          <div className="flex flex-wrap gap-2 border-t border-line px-4 py-2">
            {compose.attachments.map((a, i) => (
              <span
                key={`${a.filename}-${i}`}
                className="flex items-center gap-1.5 rounded-md border border-line-strong bg-raised py-1 pl-2.5 pr-1 text-[12px] text-ink-2"
              >
                📎 {a.filename}
                <span className="text-ink-3">
                  {fmtSize(Math.round(a.dataBase64.length * 0.75))}
                </span>
                <button
                  onClick={() =>
                    patch({
                      attachments: compose.attachments.filter((_, j) => j !== i),
                    })
                  }
                  className="rounded px-1 text-ink-3 hover:bg-hover hover:text-ink"
                  title="Remove attachment"
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}

        {compose.signature &&
          (/<\w+[^>]*>/.test(compose.signature) ? (
            <div
              className="selectable max-h-36 overflow-y-auto rounded-b-none border-t border-line bg-white px-4 py-2 text-[12.5px] leading-relaxed text-neutral-800"
              title="Signature — set per account in Settings → Account"
              // user-authored, sanitized again at render as defense in depth
              dangerouslySetInnerHTML={{ __html: sanitizeUserHtml(compose.signature) }}
            />
          ) : (
            <div
              className="whitespace-pre-wrap border-t border-line px-4 py-2 text-[12.5px] leading-relaxed text-ink-2"
              title="Signature — set per account in Settings → Account"
            >
              {compose.signature}
            </div>
          ))}

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
            onClick={() => window.dispatchEvent(new CustomEvent("fission:send"))}
            disabled={sending}
            className="rounded-md bg-accent px-4 py-1.5 text-[13px] font-medium text-on-accent hover:bg-accent-strong disabled:opacity-50"
          >
            {sending ? "Sending…" : "Send"}
          </button>
          <button
            onClick={() => fileRef.current?.click()}
            className="rounded-md px-3 py-1.5 text-[13px] text-ink-2 hover:bg-hover"
            title="Attach files"
          >
            📎 Attach
          </button>
          <input
            ref={fileRef}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => {
              void addFiles(e.target.files);
              e.target.value = "";
            }}
          />
          <button
            onClick={() => {
              const c = useUi.getState().compose;
              if (c?.draftId != null) void backend.deleteDraft(c.draftId).catch(() => {});
              useUi.getState().closeCompose();
            }}
            className="rounded-md px-3 py-1.5 text-[13px] text-ink-2 hover:bg-hover"
            title="Delete the draft and close (Esc keeps it)"
          >
            Discard
          </button>
          {error && <span className="text-[12px] text-bad">{error}</span>}
        </div>
      </div>
    </div>
  );
}
