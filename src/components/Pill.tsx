// Count/status pill (design system core/Badge · Pill).

export function Badge({
  children,
  tone = "neutral",
}: {
  children: React.ReactNode;
  tone?: "neutral" | "active" | "solid";
}) {
  const cls =
    tone === "solid"
      ? "border-transparent bg-accent text-on-accent"
      : tone === "active"
        ? "border-accent/40 bg-accent-dim text-accent-strong"
        : "border-line bg-raised text-ink-3";
  return (
    <span
      className={`inline-block min-w-[18px] rounded-full border px-1.5 text-center text-[10.5px] leading-[17px] tabular-nums ${cls}`}
    >
      {children}
    </span>
  );
}
