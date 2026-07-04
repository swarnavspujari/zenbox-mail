// To/Cc field with recipient autocomplete: as you type a recipient, the
// closest matching contacts (by name or email, ranked by how often you've
// corresponded) drop down; Enter/Tab/click fills in "Name <email>". Contacts
// come from synced mail via backend.searchContacts — no extra OAuth scope.
import { useEffect, useRef, useState } from "react";
import { backend } from "@/lib/ipc";
import { Avatar } from "@/components/Avatar";
import type { Contact } from "@/lib/types";

const DEBOUNCE_MS = 120;

/** The recipient token straddling the caret (between the surrounding commas). */
function tokenAt(value: string, caret: number) {
  let start = 0;
  for (let i = caret - 1; i >= 0; i--) {
    if (value[i] === "," || value[i] === ";") {
      start = i + 1;
      break;
    }
  }
  let end = value.length;
  for (let i = caret; i < value.length; i++) {
    if (value[i] === "," || value[i] === ";") {
      end = i;
      break;
    }
  }
  return { start, end, text: value.slice(start, end).trim() };
}

export function RecipientInput({
  value,
  onChange,
  placeholder,
  autoFocus,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  autoFocus?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [suggestions, setSuggestions] = useState<Contact[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const seq = useRef(0);
  const caretRef = useRef(0);

  useEffect(() => {
    if (autoFocus) inputRef.current?.focus();
  }, [autoFocus]);

  const refresh = (val: string, caret: number) => {
    caretRef.current = caret;
    const tok = tokenAt(val, caret).text;
    const id = ++seq.current;
    if (tok.length < 1) {
      setSuggestions([]);
      setOpen(false);
      return;
    }
    setTimeout(() => {
      if (seq.current !== id) return;
      backend
        .searchContacts(tok)
        .then((hits) => {
          if (seq.current !== id) return;
          setSuggestions(hits);
          setActive(0);
          setOpen(hits.length > 0);
        })
        .catch(() => {});
    }, DEBOUNCE_MS);
  };

  const accept = (c: Contact) => {
    const el = inputRef.current;
    const caret = el?.selectionStart ?? caretRef.current;
    const tok = tokenAt(value, caret);
    // The send path splits recipients on , and ; — a name containing either
    // would break it, so fall back to the bare email in that (rare) case.
    const safeName = c.name && !/[,;]/.test(c.name) ? c.name : "";
    const formatted = safeName ? `${safeName} <${c.email}>` : c.email;
    const head = value.slice(0, tok.start).trimEnd();
    const tail = value.slice(tok.end).replace(/^[\s,;]+/, "");
    const next = `${head ? head + " " : ""}${formatted}, ${tail}`;
    onChange(next);
    setOpen(false);
    setSuggestions([]);
    const pos = (head ? head.length + 1 : 0) + formatted.length + 2;
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(pos, pos);
    });
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!open || suggestions.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(suggestions.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      accept(suggestions[active]);
    } else if (e.key === "Escape") {
      // close the dropdown only — don't let Esc bubble to the compose closer
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
    }
  };

  return (
    <div className="relative flex-1">
      <input
        ref={inputRef}
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          refresh(e.target.value, e.target.selectionStart ?? e.target.value.length);
        }}
        onClick={(e) => refresh(value, e.currentTarget.selectionStart ?? 0)}
        onKeyUp={(e) => {
          if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key))
            refresh(value, e.currentTarget.selectionStart ?? 0);
        }}
        onKeyDown={onKeyDown}
        onBlur={() => setTimeout(() => setOpen(false), 120)}
        className="w-full bg-transparent text-[13px] text-ink outline-none placeholder:text-ink-3"
        placeholder={placeholder}
        autoComplete="off"
        spellCheck={false}
      />
      {open && (
        <div className="zb-fade-in absolute left-0 right-0 top-full z-10 mt-1 max-h-64 overflow-y-auto rounded-lg border border-line-strong bg-overlay py-1 shadow-2xl">
          {suggestions.map((c, i) => (
            <button
              key={c.email}
              // onMouseDown (not onClick) so it fires before the input's blur
              onMouseDown={(e) => {
                e.preventDefault();
                accept(c);
              }}
              onMouseEnter={() => setActive(i)}
              className={`flex w-full items-center gap-2.5 px-3 py-1.5 text-left ${
                i === active ? "bg-selected" : "hover:bg-hover"
              }`}
            >
              <Avatar name={c.name || c.email} email={c.email} size={22} />
              <span className="min-w-0 flex-1">
                {c.name && (
                  <span className="mr-1.5 text-[13px] text-ink">{c.name}</span>
                )}
                <span className="text-[12px] text-ink-3">{c.email}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
