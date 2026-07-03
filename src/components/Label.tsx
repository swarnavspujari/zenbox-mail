// Colored label/tag chip (design system mail/Label): soft tinted fill with
// legible same-hue text, theme-aware via the --tag-* token pairs.

export type TagColor = "violet" | "amber" | "green" | "blue" | "pink" | "gray";

const TAG_COLORS: TagColor[] = ["violet", "amber", "green", "blue", "pink", "gray"];

/** Deterministic tag color for a label name (same label → same hue). */
export function tagColorOf(name: string): TagColor {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
  // gray is reserved for explicit use; hash across the five real hues
  return TAG_COLORS[((h % 5) + 5) % 5];
}

export function Label({
  children,
  color,
}: {
  children: React.ReactNode;
  color?: TagColor;
}) {
  const c = color ?? (typeof children === "string" ? tagColorOf(children) : "gray");
  return (
    <span
      className="inline-flex shrink-0 items-center whitespace-nowrap rounded px-[7px] text-[11px] font-medium leading-4"
      style={{ background: `var(--tag-${c}-bg)`, color: `var(--tag-${c}-fg)` }}
    >
      {children}
    </span>
  );
}
