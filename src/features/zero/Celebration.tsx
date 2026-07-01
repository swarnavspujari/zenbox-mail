import { useEffect } from "react";
import { useUi } from "@/stores/ui";

/** Full-screen Inbox-Zero moment: celebration image + streak. Any key or
 *  click dismisses. */
export function Celebration() {
  const event = useUi((s) => s.celebration)!;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      useUi.getState().dismissCelebration();
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () =>
      window.removeEventListener("keydown", onKey, { capture: true });
  }, []);

  const src = event.imagePath.startsWith("/")
    ? event.imagePath
    : `zenbox-celebration://${event.imagePath}`;

  return (
    <div
      className="zb-fade-in absolute inset-0 z-50 cursor-pointer"
      onClick={() => useUi.getState().dismissCelebration()}
    >
      <img
        src={src}
        alt="Inbox zero celebration"
        className="absolute inset-0 h-full w-full object-cover"
        draggable={false}
      />
      <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-transparent to-black/30" />
      <div className="absolute inset-x-0 bottom-16 flex flex-col items-center gap-2 text-center">
        <div className="text-3xl font-semibold tracking-tight text-white/90 drop-shadow">
          Inbox Zero
        </div>
        <div className="text-[15px] text-white/80 drop-shadow">
          {event.daily} day{event.daily === 1 ? "" : "s"} in a row
          {event.weekly > 0 && (
            <> · {event.weekly} week{event.weekly === 1 ? "" : "s"} streak</>
          )}
        </div>
        <div className="mt-2 text-[12px] text-white/60">
          press any key to keep going
        </div>
      </div>
    </div>
  );
}
