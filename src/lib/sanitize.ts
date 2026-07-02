// Minimal HTML sanitizer for user-authored rich content (signatures).
// Signatures are the user's own markup, but rich text is often *pasted* from
// arbitrary pages — strip anything active before it touches the DOM or an
// outgoing message. (Inbound mail is sanitized separately, in Rust.)

const STRIP_ELEMENTS = "script, iframe, object, embed, link, meta, form, base";

export function sanitizeUserHtml(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc.querySelectorAll(STRIP_ELEMENTS).forEach((el) => el.remove());
  for (const el of Array.from(doc.body.querySelectorAll("*"))) {
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      if (name.startsWith("on")) {
        el.removeAttribute(attr.name);
      } else if (
        (name === "href" || name === "src" || name === "srcset" || name === "xlink:href") &&
        /^\s*(javascript|vbscript):/i.test(attr.value)
      ) {
        el.removeAttribute(attr.name);
      }
    }
  }
  return doc.body.innerHTML;
}
