// The bottom action bar, shared by both composer shells. Matches Superhuman's
// layout: text actions on the left (Send · Send later), icon actions on the
// right (✦ AI · {} snippet · 📎 attach · 🗑 discard), with a send-key hint. The
// hidden file <input> that backs 📎 lives here so the whole attach flow is in
// one place. 📎 opens a two-item flyout: local files or Google Drive.
import { useEffect, useRef, useState } from "react";
import { formatKeyExpr } from "@/lib/keyboard";
import { runCommandById, shortcutHint } from "@/lib/commands";
import { useUi } from "@/stores/ui";

/** 📎 → a small upward flyout: attach local files, or open the Drive picker. */
function AttachFlyout({ fileRef }: { fileRef: React.RefObject<HTMLInputElement> }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [open]);

  const item =
    "flex w-full items-center gap-2 whitespace-nowrap px-3 py-1.5 text-left text-[12.5px] text-ink-2 hover:bg-hover hover:text-ink";

  return (
    <div ref={rootRef} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className={`rounded px-1.5 py-1 text-[13px] ${
          open ? "text-ink" : "text-ink-3 hover:text-ink"
        }`}
        title="Attach…"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        📎
      </button>
      {open && (
        <div
          role="menu"
          className="zb-pop-in absolute bottom-full right-0 z-30 mb-1 overflow-hidden rounded-lg border border-line-strong bg-overlay py-1 shadow-2xl"
        >
          <button
            role="menuitem"
            className={item}
            onClick={() => {
              setOpen(false);
              fileRef.current?.click();
            }}
          >
            📎 Attach files…
          </button>
          <button
            role="menuitem"
            className={item}
            onClick={() => {
              setOpen(false);
              useUi.getState().openPicker("drivePicker");
            }}
            title={`Attach from Google Drive (${formatKeyExpr(shortcutHint("compose.attachDrive"))})`}
          >
            ▲ Attach from Google Drive…
          </button>
        </div>
      )}
    </div>
  );
}

export function ComposeActionBar({
  sending,
  error,
  fileRef,
  addFiles,
}: {
  sending: boolean;
  error: string | null;
  fileRef: React.RefObject<HTMLInputElement>;
  addFiles: (files: FileList | null) => void | Promise<void>;
}) {
  const aiBarOpen = useUi((s) => s.aiBarOpen);

  return (
    <div className="flex items-center gap-3 border-t border-line px-4 py-2.5">
      <button
        onClick={() => window.dispatchEvent(new CustomEvent("fission:send"))}
        disabled={sending}
        className="rounded-md bg-accent px-4 py-1.5 text-[13px] font-medium text-on-accent hover:bg-accent-strong disabled:opacity-50"
      >
        {sending ? "Sending…" : "Send"}
      </button>
      <button
        onClick={() => useUi.getState().openPicker("sendLater")}
        className="text-[12.5px] text-ink-2 hover:text-ink"
      >
        Send later
      </button>
      <div className="flex-1" />
      <button
        onClick={() => useUi.getState().setAiBarOpen(!aiBarOpen)}
        className={`rounded px-1.5 py-1 text-[13px] ${
          aiBarOpen ? "text-accent-strong" : "text-ink-3 hover:text-ink"
        }`}
        title={`Write with AI (${formatKeyExpr(shortcutHint("compose.ai"))})`}
      >
        ✦
      </button>
      <button
        onClick={() => useUi.getState().openPicker("snippet")}
        className="rounded px-1.5 py-1 text-[13px] text-ink-3 hover:text-ink"
        title="Insert snippet"
      >
        {"{ }"}
      </button>
      <AttachFlyout fileRef={fileRef} />
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
        onClick={() => runCommandById("compose.discard")}
        className="rounded px-1.5 py-1 text-[13px] text-ink-3 hover:text-bad"
        title={`Discard draft (${formatKeyExpr(shortcutHint("compose.discard"))})`}
      >
        🗑
      </button>
      {error && <span className="ml-1 text-[12px] text-bad">{error}</span>}
    </div>
  );
}
