// Boxed text input (design system forms/Input).

export function Input({
  value,
  onChange,
  placeholder,
  type = "text",
  label,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
  label?: string;
}) {
  return (
    <label className="flex items-center gap-2 rounded-md border border-line-strong bg-surface px-3 py-1.5 focus-within:border-accent">
      {label && <span className="shrink-0 text-[12px] text-ink-3">{label}</span>}
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="min-w-0 flex-1 bg-transparent text-[13px] text-ink outline-none placeholder:text-ink-3"
      />
    </label>
  );
}
