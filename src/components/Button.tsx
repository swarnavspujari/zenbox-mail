// Buttons (design system forms/Button · IconButton).

export function Button({
  children,
  variant = "primary",
  size = "md",
  onClick,
  disabled,
  title,
}: {
  children: React.ReactNode;
  variant?: "primary" | "secondary" | "quiet" | "danger";
  size?: "sm" | "md";
  onClick?: () => void;
  disabled?: boolean;
  title?: string;
}) {
  const sizes = size === "sm" ? "px-2.5 py-1 text-[12px]" : "px-4 py-1.5 text-[13px]";
  const variants = {
    primary:
      "border-transparent bg-accent text-on-accent hover:bg-accent-strong",
    secondary:
      "border-line-strong bg-transparent text-ink-2 hover:bg-hover hover:text-ink",
    quiet: "border-transparent bg-transparent text-ink-2 hover:bg-hover",
    danger: "border-transparent bg-bad text-on-accent hover:opacity-90",
  }[variant];
  return (
    <button
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={`inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md border font-medium disabled:opacity-50 ${sizes} ${variants}`}
    >
      {children}
    </button>
  );
}

export function IconButton({
  children,
  label,
  onClick,
  bordered,
  active,
}: {
  children: React.ReactNode;
  label: string;
  onClick?: (e: React.MouseEvent) => void;
  bordered?: boolean;
  active?: boolean;
}) {
  return (
    <button
      aria-label={label}
      title={label}
      onClick={onClick}
      className={`inline-flex h-7 w-7 items-center justify-center rounded-md border text-[15px] ${
        bordered ? "border-line" : "border-transparent"
      } ${
        active
          ? "bg-hover text-accent-strong"
          : "text-ink-2 hover:bg-hover hover:text-ink"
      }`}
    >
      {children}
    </button>
  );
}
