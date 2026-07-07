// The shared inner body of both composers — recipients → editor → quoted
// history → attachments → AI bar → action bar — parameterized by `variant`.
// The two shells (Compose.tsx modal, ReplyDock.tsx inline) wrap this in their
// own chrome. Exactly one is ever mounted (ui.compose is singular), so the lone
// useComposeController here (send/autosave/attach) runs once.
//
//   modal (new message): fills the card (flex column, editor flexes/scrolls);
//     signature is seeded inside the body; no quoted history.
//   dock (reply/forward): grows inline; signature + quoted history render behind
//     the ••• in a sandboxed, editable QuoteFrame.
import { useCallback, useEffect, useRef, useState } from "react";
import type { Editor } from "@tiptap/react";
import { useSettings } from "@/stores/settings";
import { useUi } from "@/stores/ui";
import { ComposeEditor } from "./ComposeEditor";
import { RecipientFields } from "./RecipientFields";
import { AttachmentChips } from "./AttachmentChips";
import { ComposeAiBar } from "./ComposeAiBar";
import { ComposeActionBar } from "./ComposeActionBar";
import { QuoteFrame } from "./QuoteFrame";
import {
  cancelDriveUpload,
  chooseShareMode,
  confirmDriveUpload,
  useComposeController,
} from "./useComposeController";

const modalBtn =
  "rounded-md bg-accent px-3 py-1.5 text-[12.5px] font-medium text-on-accent hover:bg-accent-strong";
const modalGhost =
  "rounded-md border border-line-strong px-3 py-1.5 text-[12.5px] text-ink-2 hover:bg-hover";

/** While a compose modal is up, Escape must cancel THE MODAL — not bubble to
 *  the global engine's `back` and tear down the whole composer (abandoning
 *  the send and leaking the share resolver). Capture-phase, so it wins over
 *  the window-level keyboard engine. */
function useEscapeToCancel(cancel: () => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        cancel();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [cancel]);
}

/** "Too big to attach — upload to Google Drive and insert a link?" */
function DriveUploadPrompt({ names }: { names: string[] }) {
  const [remember, setRemember] = useState(false);
  useEscapeToCancel(cancelDriveUpload);
  return (
    <div
      className="zb-fade-in fixed inset-0 z-40 flex items-center justify-center bg-black/50"
      onClick={cancelDriveUpload}
    >
      <div
        className="zb-pop-in w-[460px] max-w-[90vw] rounded-xl border border-line-strong bg-overlay p-4 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-[13.5px] font-medium text-ink">
          Too big to attach — send {names.length === 1 ? "it" : "them"} with
          Google Drive?
        </div>
        <div className="mt-1.5 max-h-24 overflow-y-auto text-[12.5px] text-ink-2">
          {names.map((n) => (
            <div key={n} className="truncate">
              ▲ {n}
            </div>
          ))}
        </div>
        <p className="mt-2 text-[12px] text-ink-3">
          Files over the 25 MB email limit upload to your "Fission Mail
          Attachments" Drive folder and go out as a link, like Gmail. You'll
          choose who the links are shared with when you send.
        </p>
        <label className="mt-3 flex cursor-pointer items-center gap-2 text-[12px] text-ink-2">
          <input
            type="checkbox"
            checked={remember}
            onChange={(e) => setRemember(e.target.checked)}
          />
          Always upload oversized attachments without asking
        </label>
        <div className="mt-3 flex justify-end gap-2">
          <button className={modalGhost} onClick={cancelDriveUpload}>
            Cancel
          </button>
          <button className={modalBtn} onClick={() => confirmDriveUpload(remember)}>
            Upload &amp; link
          </button>
        </div>
      </div>
    </div>
  );
}

/** Share-on-send: who can open the linked Drive files? */
function SharePrompt({ count }: { count: number }) {
  const remembered = useSettings((s) => s.settings.driveShareMode);
  useEscapeToCancel(() => chooseShareMode("cancel"));
  const options = [
    {
      mode: "recipients" as const,
      label: "Share with recipients",
      detail: "Everyone on this email can view",
    },
    {
      mode: "anyone" as const,
      label: "Anyone with the link",
      detail: "Anyone who gets the link can view",
    },
    {
      mode: "none" as const,
      label: "Don't change access",
      detail: "Recipients without access will have to request it",
    },
  ];
  return (
    <div
      className="zb-fade-in fixed inset-0 z-40 flex items-center justify-center bg-black/50"
      onClick={() => chooseShareMode("cancel")}
    >
      <div
        className="zb-pop-in w-[440px] max-w-[90vw] rounded-xl border border-line-strong bg-overlay p-4 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-[13.5px] font-medium text-ink">
          {count === 1 ? "1 Drive file is" : `${count} Drive files are`} linked
          in this email
        </div>
        <div className="mt-2 space-y-1">
          {options.map((o) => (
            <button
              key={o.mode}
              onClick={() => chooseShareMode(o.mode)}
              className={`block w-full rounded-md border px-3 py-2 text-left hover:bg-hover ${
                o.mode === remembered ? "border-accent" : "border-line"
              }`}
            >
              <div className="text-[13px] text-ink">{o.label}</div>
              <div className="text-[11.5px] text-ink-3">{o.detail}</div>
            </button>
          ))}
        </div>
        <div className="mt-3 flex justify-end">
          <button className={modalGhost} onClick={() => chooseShareMode("cancel")}>
            Cancel send
          </button>
        </div>
      </div>
    </div>
  );
}

export function ComposeShell({ variant }: { variant: "modal" | "dock" }) {
  const compose = useUi((s) => s.compose)!;
  const aiBarOpen = useUi((s) => s.aiBarOpen);
  const drivePrompt = useUi((s) => s.drivePrompt);
  const sharePrompt = useUi((s) => s.sharePrompt);
  const { sending, error, fileRef, addFiles } = useComposeController();
  const [editor, setEditor] = useState<Editor | null>(null);
  const [showQuote, setShowQuote] = useState(false);
  const dotsRef = useRef<HTMLButtonElement>(null);

  const patch = (p: Partial<typeof compose>) =>
    useUi.setState((s) => ({ compose: s.compose ? { ...s.compose, ...p } : null }));

  const onBody = useCallback((body: string) => {
    useUi.setState((s) => ({ compose: s.compose ? { ...s.compose, body } : null }));
  }, []);

  // Insert rich HTML (Drive link chips) at the caret. An event, not store
  // state: the editor is uncontrolled after seeding, so writing to
  // compose.body would never reach it — only the live instance can insert.
  useEffect(() => {
    if (!editor) return;
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as
        | { html?: string; focus?: boolean }
        | undefined;
      if (!detail?.html) return;
      // Trailing space exits the link mark so typing after a chip is plain.
      // focus:false (async inserts like finished uploads) leaves the caret
      // wherever the user is typing instead of yanking it into the body.
      const chain = detail.focus === false ? editor.chain() : editor.chain().focus();
      chain.insertContent(`${detail.html} `).run();
    };
    window.addEventListener("fission:insert-html", handler);
    return () => window.removeEventListener("fission:insert-html", handler);
  }, [editor]);

  const isDock = variant === "dock";
  const hasQuote = compose.quote.trim().length > 0;

  return (
    <div className={isDock ? "" : "flex min-h-0 flex-1 flex-col"}>
      <RecipientFields variant={variant} />

      <ComposeEditor
        mode={compose.mode}
        variant={variant}
        initialContent={compose.body}
        placeholder={
          isDock ? "Tip: Hit Ctrl+J for AI" : "Write, or press Ctrl+J to draft with AI…"
        }
        onChange={onBody}
        onReady={setEditor}
        onArrowDownAtEnd={
          isDock && hasQuote ? () => dotsRef.current?.focus() : undefined
        }
      />

      {/* Signature + quoted history — rendered faithfully AND editable in a
          sandboxed frame, tucked behind a subtle ••• (↓ from the message
          focuses it; Enter/click toggles it). Reply/forward only. */}
      {hasQuote && (
        <div className="px-4 pb-1">
          <button
            ref={dotsRef}
            onClick={() => setShowQuote((s) => !s)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                setShowQuote((s) => !s);
              }
            }}
            title={
              showQuote
                ? "Hide signature & quoted history"
                : "Show signature & quoted history (editable)"
            }
            aria-label="Toggle signature and quoted history"
            aria-expanded={showQuote}
            className="fm-dots"
          >
            ···
          </button>
          {showQuote && (
            <QuoteFrame
              html={compose.quote}
              editable
              onChange={(q) => patch({ quote: q })}
              onEscape={() => {
                setShowQuote(false);
                editor?.commands.focus("end");
              }}
            />
          )}
        </div>
      )}

      <AttachmentChips />

      {aiBarOpen && editor && (
        <ComposeAiBar editor={editor} preserveSignature={!isDock} />
      )}

      <ComposeActionBar
        sending={sending}
        error={error}
        fileRef={fileRef}
        addFiles={addFiles}
      />

      {drivePrompt && <DriveUploadPrompt names={drivePrompt.names} />}
      {sharePrompt && <SharePrompt count={sharePrompt.count} />}
    </div>
  );
}
