// Far-left icon rail (design system navigation/NavRail): brand mark on top,
// then one monochrome glyph per top-level surface.
import type { CSSProperties } from "react";
import { useSettings } from "@/stores/settings";

// Over the inbox-zero photo the rail goes frosted: token overrides let the
// same classes render white-on-photo (matches App's ZERO_CHROME treatment).
const OVERLAY_VARS = {
  "--bg-base": "transparent",
  "--bg-raised": "rgba(255,255,255,0.20)",
  "--bg-hover": "rgba(255,255,255,0.14)",
  "--text-secondary": "rgba(255,255,255,0.9)",
  "--text-muted": "rgba(255,255,255,0.62)",
  "--border": "rgba(255,255,255,0.28)",
  "--accent-strong": "#fff",
} as CSSProperties;

function RailButton({
  children,
  label,
  active,
  onClick,
}: {
  children: React.ReactNode;
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      aria-label={label}
      title={label}
      onClick={onClick}
      className={`flex h-[34px] w-[34px] items-center justify-center rounded-lg border text-[17px] ${
        active
          ? "border-line bg-raised text-accent-strong"
          : "border-transparent text-ink-3 hover:bg-hover hover:text-ink-2"
      }`}
    >
      {children}
    </button>
  );
}

export function NavRail({
  view,
  onMail,
  onCalendar,
  overlay,
}: {
  view: "mail" | "calendar";
  onMail: () => void;
  onCalendar: () => void;
  /** Render translucently over the inbox-zero photo. */
  overlay?: boolean;
}) {
  const theme = useSettings((s) => s.settings.theme);
  return (
    <nav
      className={`relative flex w-14 shrink-0 flex-col items-center gap-2 bg-base py-3 ${
        overlay ? "" : "border-r border-line"
      }`}
      style={overlay ? OVERLAY_VARS : undefined}
    >
      {/* The rocket-snail mark — ink flips with the theme (navy on light,
          near-white on dark); over the photo it's always the on-dark cut. */}
      <img
        src={
          !overlay && theme === "light"
            ? "/snail-mail-icon.svg"
            : "/snail-mail-icon-on-dark.svg"
        }
        alt="Snail Mail"
        className="mb-2 h-8 w-8"
        draggable={false}
      />
      <RailButton label="Mail" active={view === "mail"} onClick={onMail}>
        ✉
      </RailButton>
      <RailButton
        label="Calendar"
        active={view === "calendar"}
        onClick={onCalendar}
      >
        ▦
      </RailButton>
    </nav>
  );
}
