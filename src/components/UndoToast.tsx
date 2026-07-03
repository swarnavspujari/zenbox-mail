// Bottom-left toast with an accent bar and an inline Undo affordance
// (design system feedback/UndoToast).
import { hasUndo, popUndo } from "@/lib/undo";
import { useUi } from "@/stores/ui";

export function UndoToast({ message }: { message: string }) {
  const undoable = hasUndo();
  return (
    <div className="zb-pop-in absolute bottom-5 left-5 z-25 flex min-w-[260px] max-w-[380px] items-stretch gap-3 overflow-hidden rounded-lg border border-line-strong bg-raised shadow-[0_8px_24px_rgba(0,0,0,0.45)]">
      <span className="w-[3px] shrink-0 bg-accent" />
      <span className="flex-1 py-2.5 text-[13px] text-ink">{message}</span>
      {undoable && (
        <button
          onClick={() => {
            void popUndo().then((handled) => {
              if (!handled) useUi.getState().showToast("Nothing to undo");
            });
          }}
          className="text-[12px] font-semibold uppercase tracking-wide text-accent-strong hover:text-accent"
        >
          Undo
        </button>
      )}
      <button
        aria-label="Dismiss"
        onClick={() => useUi.setState({ toast: null })}
        className="py-2.5 pl-1 pr-3.5 text-[15px] text-ink-3 hover:text-ink"
      >
        ×
      </button>
    </div>
  );
}
