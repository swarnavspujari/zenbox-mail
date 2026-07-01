import { useEffect, useRef, useState } from "react";
import { useMail } from "@/stores/mail";
import { useUi } from "@/stores/ui";

export function SearchScreen() {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const results = useMail((s) => s.searchResults);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const t = setTimeout(() => void useMail.getState().runSearch(query), 120);
    return () => clearTimeout(t);
  }, [query]);

  useEffect(() => setIndex(0), [results]);

  const open = async (threadId: string) => {
    useUi.getState().setScreen("mail");
    await useMail.getState().openThread(threadId);
  };

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-line bg-surface px-6 py-3">
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setIndex((i) => Math.min(results.length - 1, i + 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setIndex((i) => Math.max(0, i - 1));
            } else if (e.key === "Enter" && results[index]) {
              e.preventDefault();
              void open(results[index].threadId);
            } else if (e.key === "Escape") {
              e.preventDefault();
              useUi.getState().setScreen("mail");
            }
          }}
          placeholder="Search mail — full-text, instant…"
          className="w-full rounded-lg border border-line-strong bg-raised px-4 py-2.5 text-[14px] text-ink outline-none placeholder:text-ink-3 focus:border-accent"
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {results.map((r, i) => (
          <button
            key={r.threadId}
            onClick={() => void open(r.threadId)}
            onMouseEnter={() => setIndex(i)}
            className={`flex w-full items-baseline gap-3 border-b border-line px-6 py-3 text-left ${
              i === index ? "bg-selected" : "hover:bg-hover"
            }`}
          >
            <span className="w-1/3 truncate font-medium text-ink">
              {r.subject}
            </span>
            <span className="min-w-0 flex-1 truncate text-[12.5px] text-ink-3">
              {r.snippet}
            </span>
            <span className="shrink-0 text-[11.5px] text-ink-3">
              {new Date(r.lastDate).toLocaleDateString()}
            </span>
          </button>
        ))}
        {query && results.length === 0 && (
          <div className="px-6 py-10 text-center text-[13px] text-ink-3">
            No results for “{query}”
          </div>
        )}
      </div>
    </div>
  );
}
