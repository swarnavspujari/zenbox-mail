// Render-time preparation of sanitized email HTML (Superhuman-style):
// strip the hidden-preheader line and the leading duplicate-subject block
// before the body goes into the reading pane's shadow root. Operates on
// already-sanitized markup — this is presentation cleanup, not a sanitizer.

/** Zero-width / joiner / nbsp characters senders use to pad preview text. */
const INVISIBLE_RE = /[\s ­͏​-‍⁠﻿]/g;

const MAX_PREHEADER_STRIPS = 15;

export function prepareEmailHtml(
  html: string,
  opts: { subject?: string | null } = {}
): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  if (!doc.body) return html;
  const hiddenClasses = collectHiddenClasses(doc);
  stripLeadingPreheader(doc.body, hiddenClasses);
  if (opts.subject) stripLeadingSubjectEcho(doc.body, opts.subject, hiddenClasses);
  // The parser hoists leading <style> into <head>; keep it with the body.
  return (doc.head?.innerHTML ?? "") + doc.body.innerHTML;
}

/** Class names hidden unconditionally by the email's OWN <style> rules — the
 *  `.preheader{display:none}` pattern. These render invisible (the styles are
 *  kept), so the scans must look through them; they are never removed, since
 *  a static parse can't prove an override elsewhere doesn't reveal them.
 *  Rules inside @media are skipped: width-conditional hiding isn't hidden. */
function collectHiddenClasses(doc: Document): Set<string> {
  const hidden = new Set<string>();
  for (const styleEl of doc.querySelectorAll("style")) {
    for (const rule of topLevelRules(styleEl.textContent ?? "")) {
      if (
        !/display\s*:\s*none|visibility\s*:\s*hidden|mso-hide\s*:\s*all/i.test(
          rule.body
        )
      ) {
        continue;
      }
      for (const sel of rule.prelude.split(",")) {
        const m = sel.trim().match(/^[a-z]*\.([\w-]+)$/i);
        if (m) hidden.add(m[1]);
      }
    }
  }
  return hidden;
}

/** Rules outside any at-rule block, by brace counting. */
function topLevelRules(css: string): { prelude: string; body: string }[] {
  const rules: { prelude: string; body: string }[] = [];
  let depth = 0;
  let start = 0;
  let prelude = "";
  for (let i = 0; i < css.length; i++) {
    const c = css[i];
    if (c === "{") {
      if (depth === 0) {
        prelude = css.slice(start, i);
        start = i + 1;
      }
      depth++;
    } else if (c === "}") {
      depth--;
      if (depth === 0) {
        if (!prelude.trim().startsWith("@")) {
          rules.push({ prelude, body: css.slice(start, i) });
        }
        start = i + 1;
      } else if (depth < 0) {
        depth = 0;
      }
    }
  }
  return rules;
}

const visibleText = (s: string | null) => (s ?? "").replace(INVISIBLE_RE, "");

/** Inline-style hiding techniques preheaders rely on. Class-based hiding
 *  needs no handling here — the email's own (kept) <style> hides those. */
function isInlineHidden(el: Element): boolean {
  const st = (el as HTMLElement).style;
  if (!st) return false;
  const px = (v: string) => {
    const n = parseFloat(v);
    return Number.isNaN(n) ? null : n;
  };
  const fontSize = px(st.fontSize);
  const maxHeight = px(st.maxHeight);
  const height = px(st.height);
  const opacity = px(st.opacity);
  const hidesOverflow = /hidden/i.test(st.overflow || st.overflowY);
  return (
    st.display === "none" ||
    st.visibility === "hidden" ||
    (opacity !== null && opacity <= 0.01) ||
    (fontSize !== null && fontSize <= 2) ||
    (maxHeight !== null && maxHeight <= 1) ||
    (height !== null && height <= 1 && hidesOverflow) ||
    /mso-hide\s*:\s*all/i.test(el.getAttribute("style") ?? "")
  );
}

/** A block whose text is nothing but a long run of invisible characters —
 *  the classic `&zwnj;&nbsp;…` preview-text padding. A short spacer
 *  (`<div>&nbsp;</div>`) stays. */
function isInvisiblePadding(el: Element): boolean {
  if (el.querySelector("img")) return false;
  const raw = el.textContent ?? "";
  return visibleText(raw).length === 0 && raw.length >= 8;
}

function isTrackingPixel(el: Element): boolean {
  const dim = (name: string) => parseFloat(el.getAttribute(name) ?? "");
  return dim("width") <= 2 || dim("height") <= 2;
}

function isHiddenByClass(el: Element, hiddenClasses: Set<string>): boolean {
  if (hiddenClasses.size === 0) return false;
  const inlineDisplay = (el as HTMLElement).style?.display;
  if (inlineDisplay && inlineDisplay !== "none") return false; // inline wins
  return [...el.classList].some((c) => hiddenClasses.has(c));
}

/** Remove hidden/preheader elements that precede the first visible content,
 *  in document order. Returns true once visible content is found. */
function stripLeadingPreheader(root: Element, hiddenClasses: Set<string>): boolean {
  const state = { removed: 0 };
  const scan = (el: Element): boolean => {
    for (const node of [...el.childNodes]) {
      if (node.nodeType === Node.TEXT_NODE) {
        if (visibleText(node.textContent).length > 0) return true;
        continue;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) continue;
      const child = node as Element;
      if (child.tagName === "STYLE") continue;
      // Class-hidden: invisible but only provably so at render time — look
      // through it (don't remove, don't count as content).
      if (isHiddenByClass(child, hiddenClasses)) continue;
      if (child.tagName === "IMG") {
        if (isTrackingPixel(child)) continue;
        return true; // a real image is visible content
      }
      if (isInlineHidden(child) || isInvisiblePadding(child)) {
        child.remove();
        if (++state.removed >= MAX_PREHEADER_STRIPS) return true;
        continue;
      }
      if (scan(child)) return true;
    }
    return false;
  };
  return scan(root);
}

/** Case/whitespace/punctuation/emoji-insensitive comparison form. */
function normText(s: string): string {
  return s
    .toLowerCase()
    .replace(INVISIBLE_RE, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** Remove the leading block whose text duplicates the subject (newsletters'
 *  in-body hero title / repeated subject line). Conservative: exact match or
 *  a title the subject merely extends, and never when removal would leave
 *  the message without meaningful content. */
function stripLeadingSubjectEcho(
  body: Element,
  subject: string,
  hiddenClasses: Set<string>
): void {
  const subjNorm = normText(subject.replace(/^\s*((re|fwd?|fw)\s*:\s*)+/i, ""));
  if (subjNorm.length < 3) return;

  const firstVisibleTextNode = (el: Element): Text | null => {
    for (const node of [...el.childNodes]) {
      if (node.nodeType === Node.TEXT_NODE) {
        if (visibleText(node.textContent).length > 0) return node as Text;
        continue;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) continue;
      const child = node as Element;
      if (
        child.tagName === "STYLE" ||
        isInlineHidden(child) ||
        isHiddenByClass(child, hiddenClasses)
      ) {
        continue;
      }
      const found = firstVisibleTextNode(child);
      if (found) return found;
    }
    return null;
  };

  const textNode = firstVisibleTextNode(body);
  if (!textNode?.parentElement) return;

  // Climb to the largest ancestor that adds no further text — the whole
  // heading block (a <strong> inside a <div>, a <td> in its own row, …).
  let el: Element = textNode.parentElement;
  while (
    el.parentElement &&
    el.parentElement !== body &&
    normText(el.parentElement.textContent ?? "") === normText(el.textContent ?? "")
  ) {
    el = el.parentElement;
  }

  const cand = normText(el.textContent ?? "");
  const matches =
    cand.length >= 3 &&
    (cand === subjNorm ||
      (subjNorm.startsWith(cand) && cand.length >= Math.min(12, subjNorm.length)));
  if (!matches) return;

  // Removal must leave real content behind.
  const remaining =
    visibleText(body.textContent).length - visibleText(el.textContent).length;
  if (remaining < 40 && !bodyHasImageOutside(body, el)) return;

  el.remove();
}

function bodyHasImageOutside(body: Element, removed: Element): boolean {
  return [...body.querySelectorAll("img")].some(
    (img) => !removed.contains(img) && !isTrackingPixel(img)
  );
}
