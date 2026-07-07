// The new-message composer: a centered Superhuman-style card over a dimmed
// backdrop. All of the body — recipients, editor, attachments, AI bar, action
// bar — lives in the shared <ComposeShell/>; this file is just the card chrome
// and the header, including the ↑/↓ nav that backgrounds the draft and jumps to
// the previous/next email (mirrors J/K — see commands.ts `composeGoToEmail`).
import { formatKeyExpr } from "@/lib/keyboard";
import { shortcutHint, composeGoToEmail } from "@/lib/commands";
import { ComposeShell } from "./ComposeShell";

/** A thin up/down chevron nav button in the header. */
function NavChevron({
  dir,
  title,
  onClick,
}: {
  dir: "up" | "down";
  title: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      aria-label={title}
      className="rounded p-1 text-ink-3 hover:bg-hover hover:text-ink"
    >
      <svg
        width="20"
        height="20"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
      >
        <path
          d={dir === "up" ? "M6 15l6-6 6 6" : "M6 9l6 6 6-6"}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </button>
  );
}

export function Compose() {
  return (
    // A full content-area view (Superhuman-style), NOT a dimmed popup: the
    // opaque bg-base takes over the whole pane so the inbox never shows through,
    // and the compose fills it as a large window-style panel.
    <div className="zb-fade-in absolute inset-0 z-20 flex flex-col bg-base p-4">
      <div className="mx-auto flex h-full w-full max-w-[1100px] flex-col overflow-hidden rounded-xl border border-line-strong bg-overlay shadow-2xl">
        <div className="flex items-center gap-1 border-b border-line px-5 py-3">
          <span className="text-[15px] font-semibold text-ink">New Message</span>
          <div className="flex-1" />
          <NavChevron
            dir="up"
            title={`Previous email (${formatKeyExpr(shortcutHint("compose.prevEmail"))})`}
            onClick={() => composeGoToEmail(-1)}
          />
          <NavChevron
            dir="down"
            title={`Next email (${formatKeyExpr(shortcutHint("compose.nextEmail"))})`}
            onClick={() => composeGoToEmail(1)}
          />
        </div>

        <ComposeShell variant="modal" />
      </div>
    </div>
  );
}
