import { useEffect, useRef } from "react";
import { escapeHtml } from "@/stores/ui";
import { sanitizeUserHtml } from "@/lib/sanitize";

const MAX_IMAGE_BYTES = 500_000;

/** Initial editor HTML: legacy plain-text signatures become line-broken HTML. */
function toEditorHtml(sig: string): string {
  if (!sig) return "";
  if (/<\w+[^>]*>/.test(sig)) return sanitizeUserHtml(sig);
  return escapeHtml(sig).replace(/\n/g, "<br>");
}

/**
 * Rich signature editor: a contenteditable that accepts pasted rich HTML
 * (e.g. straight from Gmail's signature box) and inline images as data: URIs.
 * Emits sanitized HTML on every change.
 */
export function SignatureEditor({
  value,
  onChange,
}: {
  value: string;
  onChange: (html: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const lastEmitted = useRef<string | null>(null);

  useEffect(() => {
    // only rewrite the DOM when the change came from outside the editor
    if (ref.current && value !== lastEmitted.current) {
      ref.current.innerHTML = toEditorHtml(value);
    }
  }, [value]);

  const emit = () => {
    if (!ref.current) return;
    const html = sanitizeUserHtml(ref.current.innerHTML);
    lastEmitted.current = html;
    onChange(html);
  };

  const insertImage = (file: File) => {
    if (file.size > MAX_IMAGE_BYTES) {
      onChange(value); // no-op change; caller shows its own errors if needed
      window.alert("Keep signature images under 500 KB.");
      return;
    }
    const r = new FileReader();
    r.onload = () => {
      const img = document.createElement("img");
      img.src = String(r.result);
      img.style.maxHeight = "80px";
      ref.current?.appendChild(img);
      emit();
    };
    r.readAsDataURL(file);
  };

  return (
    <div>
      <div
        ref={ref}
        contentEditable
        suppressContentEditableWarning
        onInput={emit}
        onBlur={emit}
        data-placeholder="Signature — paste your Gmail signature here (formatting and images survive)"
        className="selectable min-h-16 w-full rounded-md border border-line-strong bg-raised px-3 py-2 text-[13px] leading-relaxed text-ink outline-none focus:border-accent [&:empty]:before:text-ink-3 [&:empty]:before:content-[attr(data-placeholder)]"
      />
      <div className="mt-1.5 flex items-center gap-2">
        <button
          className="rounded-md border border-line-strong px-2.5 py-1 text-[12px] text-ink-2 hover:bg-hover"
          onClick={() => fileRef.current?.click()}
        >
          🖼 Insert image
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) insertImage(f);
            e.target.value = "";
          }}
        />
        <span className="text-[11px] text-ink-3">
          Rendered exactly like this in outgoing mail.
        </span>
      </div>
    </div>
  );
}
