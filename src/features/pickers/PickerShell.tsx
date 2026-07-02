import { useEffect, useRef, useState } from "react";
import { useUi } from "@/stores/ui";

export interface PickerItem {
  label: string;
  detail?: string;
  run: () => void | Promise<void>;
}

/** Shared chrome for small keyboard-driven option lists (snooze, move…). */
export function PickerShell({
  title,
  items,
  filterable,
}: {
  title: string;
  items: PickerItem[];
  filterable?: boolean;
}) {
  const [index, setIndex] = useState(0);
  const [query, setQuery] = useState("");
  const boxRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const shown = filterable
    ? items.filter((i) => i.label.toLowerCase().includes(query.toLowerCase()))
    : items;

  useEffect(() => {
    (filterable ? inputRef : boxRef).current?.focus();
  }, [filterable]);

  useEffect(() => setIndex(0), [query]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      useUi.getState().closePicker();
    } else if (e.key === "ArrowDown" || (e.key === "j" && !filterable)) {
      e.preventDefault();
      setIndex((i) => Math.min(shown.length - 1, i + 1));
    } else if (e.key === "ArrowUp" || (e.key === "k" && !filterable)) {
      e.preventDefault();
      setIndex((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const item = shown[index];
      if (item) {
        useUi.getState().closePicker();
        void item.run();
      }
    }
  };

  return (
    <div
      className="zb-fade-in absolute inset-0 z-40 flex items-start justify-center bg-black/50 pt-[16vh]"
      onClick={() => useUi.getState().closePicker()}
    >
      <div
        ref={boxRef}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        onClick={(e) => e.stopPropagation()}
        className="zb-pop-in w-[440px] max-w-[90vw] overflow-hidden rounded-xl border border-line-strong bg-overlay shadow-2xl outline-none"
      >
        <div className="border-b border-line px-4 py-3 text-[13px] font-medium text-ink">
          {title}
        </div>
        {filterable && (
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Filter…"
            className="w-full border-b border-line bg-transparent px-4 py-2.5 text-[13px] text-ink outline-none placeholder:text-ink-3"
          />
        )}
        <div className="max-h-[46vh] overflow-y-auto py-1">
          {shown.map((item, i) => (
            <button
              key={`${i}-${item.label}`}
              onClick={() => {
                useUi.getState().closePicker();
                void item.run();
              }}
              onMouseEnter={() => setIndex(i)}
              className={`flex w-full items-center px-4 py-2 text-left text-[13px] ${
                i === index ? "bg-selected text-ink" : "text-ink-2"
              }`}
            >
              <span className="flex-1">{item.label}</span>
              {item.detail && (
                <span className="text-[11.5px] text-ink-3">{item.detail}</span>
              )}
            </button>
          ))}
          {shown.length === 0 && (
            <div className="px-4 py-5 text-center text-[13px] text-ink-3">
              Nothing matches
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
