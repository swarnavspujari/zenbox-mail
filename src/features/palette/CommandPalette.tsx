import { useEffect, useMemo, useRef, useState } from "react";
import { allCommands, runCommand, type Command } from "@/lib/commands";
import { formatKeyExpr } from "@/lib/keyboard";
import { useSettings } from "@/stores/settings";
import { useUi } from "@/stores/ui";

function fuzzyScore(query: string, text: string): number {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (!q) return 1;
  if (t.includes(q)) return 100 - t.indexOf(q);
  // subsequence match
  let qi = 0;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) qi++;
  }
  return qi === q.length ? 10 : -1;
}

export function CommandPalette() {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const shortcuts = useSettings((s) => s.settings.shortcuts);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const items = useMemo(() => {
    const available = allCommands().filter(
      (c) => !c.hidden && (!c.when || c.when())
    );
    return available
      .map((c) => ({ c, score: fuzzyScore(query, c.title) }))
      .filter((x) => x.score >= 0)
      .sort((a, b) => b.score - a.score)
      .map((x) => x.c);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  useEffect(() => {
    setIndex(0);
  }, [query]);

  const runItem = (c: Command) => {
    useUi.getState().closePalette();
    runCommand(c);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      useUi.getState().closePalette();
    } else if (e.key === "ArrowDown" || (e.key === "j" && e.ctrlKey)) {
      e.preventDefault();
      setIndex((i) => Math.min(items.length - 1, i + 1));
    } else if (e.key === "ArrowUp" || (e.key === "k" && e.ctrlKey)) {
      e.preventDefault();
      setIndex((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const c = items[index];
      if (c) runItem(c);
    }
  };

  let lastGroup = "";

  return (
    <div
      className="zb-fade-in absolute inset-0 z-40 flex items-start justify-center bg-black/50 pt-[12vh]"
      onClick={() => useUi.getState().closePalette()}
    >
      <div
        className="zb-pop-in w-[640px] max-w-[92vw] overflow-hidden rounded-xl border border-line-strong bg-overlay shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Type a command…"
          className="w-full border-b border-line bg-transparent px-4 py-3.5 text-[14px] text-ink outline-none placeholder:text-ink-3"
        />
        <div className="max-h-[52vh] overflow-y-auto py-1">
          {items.map((c, i) => {
            const header = c.group !== lastGroup ? c.group : null;
            lastGroup = c.group;
            return (
              <div key={c.id}>
                {header && (
                  <div className="px-4 pb-1 pt-2.5 text-[10.5px] font-medium uppercase tracking-wider text-ink-3">
                    {header}
                  </div>
                )}
                <button
                  onClick={() => runItem(c)}
                  onMouseEnter={() => setIndex(i)}
                  className={`flex w-full items-center px-4 py-2 text-left text-[13.5px] ${
                    i === index ? "bg-selected text-ink" : "text-ink-2"
                  }`}
                >
                  <span className="flex-1">{c.title}</span>
                  {shortcuts[c.id] && (
                    <span className="kbd">{formatKeyExpr(shortcuts[c.id])}</span>
                  )}
                </button>
              </div>
            );
          })}
          {items.length === 0 && (
            <div className="px-4 py-6 text-center text-[13px] text-ink-3">
              No matching commands
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
