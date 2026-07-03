// Far-left icon rail (design system navigation/NavRail): brand mark on top,
// then one monochrome glyph per top-level surface.

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
}: {
  view: "mail" | "calendar";
  onMail: () => void;
  onCalendar: () => void;
}) {
  return (
    <nav className="flex w-14 shrink-0 flex-col items-center gap-2 border-r border-line bg-base py-3">
      <img
        src="/fission-mark.png"
        alt="Fission Mail"
        className="mb-2 h-7 w-7 rounded-lg"
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
