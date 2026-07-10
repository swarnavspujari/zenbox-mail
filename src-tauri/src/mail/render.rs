//! Email HTML sanitization for the reading pane. Raw HTML stays in the DB;
//! this runs on read, so the allowlist can evolve without a resync.
//!
//! Threat model: untrusted mail rendered INLINE in the app document, inside a
//! shadow root whose light-DOM wrapper is a containment jail (`contain:
//! layout paint style` — email CSS can't reach the wrapper, so even a
//! surviving fixed-position element can't paint outside the message box).
//! There is no iframe sandbox anymore, so this sanitizer is the sole trust
//! boundary for active content: scripts, event handlers, forms, frames,
//! javascript:/data:text/html URLs must all die here. `<style>` elements are
//! deliberately KEPT (newsletters need them; shadow DOM scopes their
//! selectors) but their CSS is scrubbed — fixed/sticky positioning, @import,
//! legacy CSS-execution vectors, and `:host` selectors (which could restyle
//! the shadow host from inside) are dropped. The app CSP is the third layer
//! on desktop (no inline script, form-action 'none'). Remote images stay
//! allowed (tracking-pixel class of risk, same call Superhuman makes);
//! `cid:` inline images are resolved to data: URIs by the caller.
use std::borrow::Cow;
use std::collections::{HashMap, HashSet};

/// Sanitize message HTML. `cid_data` maps a Content-ID (without angle
/// brackets) to a ready-made `data:` URI for inline images.
pub fn sanitize_email_html(html: &str, cid_data: &HashMap<String, String>) -> String {
    // Resolve cid: references BEFORE sanitizing, so the data: URIs go through
    // the same allowlist as everything else.
    let html = resolve_cids(html, cid_data);

    let mut b = ammonia::Builder::default();
    b.add_tags(["center", "font", "u", "big", "small", "main", "section", "article", "header", "footer", "figure", "figcaption", "picture", "source", "span", "wbr", "s", "style"]);
    // ammonia's default is to delete <style> WITH its contents; we allow it
    // instead (scrubbed below). Leaving it in both sets would panic.
    b.rm_clean_content_tags(["style"]);
    // Presentational attributes real newsletters still use everywhere.
    // class/id are needed so kept <style> rules can actually target elements
    // (preheader hiding, layout classes); shadow DOM keeps them out of the
    // app's namespace.
    b.add_generic_attributes([
        "style", "align", "valign", "width", "height", "border", "cellpadding",
        "cellspacing", "bgcolor", "background", "color", "dir", "role",
        "class", "id",
    ]);
    b.add_tag_attributes("img", ["src", "alt", "width", "height", "border", "hspace", "vspace"]);
    b.add_tag_attributes("a", ["href", "name"]);
    b.add_tag_attributes("font", ["face", "size", "color"]);
    b.add_tag_attributes("td", ["colspan", "rowspan", "nowrap"]);
    b.add_tag_attributes("th", ["colspan", "rowspan", "nowrap"]);
    b.add_tag_attributes("source", ["srcset", "media", "type"]);
    b.add_tag_attributes("style", ["media", "type"]);
    let url_schemes: HashSet<&str> = ["http", "https", "mailto", "data", "tel"].into();
    b.url_schemes(url_schemes);
    // Per-attribute policy on top of the global scheme list: data: URIs only
    // as image bytes, never as link targets; style attributes get the same
    // CSS scrub as <style> text.
    b.attribute_filter(|element, attribute, value| -> Option<Cow<'_, str>> {
        match attribute {
            "style" => Some(Cow::Owned(scrub_css(value))),
            "href" => match url_scheme(value) {
                None => Some(value.into()),
                Some(s) if matches!(s.as_str(), "http" | "https" | "mailto" | "tel") => {
                    Some(value.into())
                }
                Some(_) => None,
            },
            "src" | "background" => match url_scheme(value) {
                None => Some(value.into()),
                Some(s) if s == "http" || s == "https" => Some(value.into()),
                Some(s) if s == "data" && is_data_image(value) && element != "a" => {
                    Some(value.into())
                }
                Some(_) => None,
            },
            // srcset URL grammar is messy (data: URIs embed commas); accept
            // the common http(s) newsletter case, drop everything else.
            "srcset" => {
                let ok = value.split(',').all(|part| {
                    let p = part.trim().to_ascii_lowercase();
                    p.starts_with("http://") || p.starts_with("https://")
                });
                if ok { Some(value.into()) } else { None }
            }
            _ => Some(value.into()),
        }
    });
    // Every link opens outside the app; rel guards the opener.
    b.link_rel(Some("noopener noreferrer"));
    let clean = b.clean(&html).to_string();
    // <style> text passes through ammonia raw; scrub it as CSS. Operating on
    // the serialized output is sound: a literal "<style" in text would have
    // been escaped to &lt;style, so every match below is a real element.
    scrub_style_elements(&clean)
}

/// Leading URL scheme (lowercased) of an attribute value, if any.
fn url_scheme(value: &str) -> Option<String> {
    let v = value.trim_start();
    let mut chars = v.char_indices();
    match chars.next() {
        Some((_, c)) if c.is_ascii_alphabetic() => {}
        _ => return None,
    }
    for (i, c) in chars {
        if c == ':' {
            return Some(v[..i].to_ascii_lowercase());
        }
        if !(c.is_ascii_alphanumeric() || c == '+' || c == '-' || c == '.') {
            return None;
        }
    }
    None
}

fn is_data_image(value: &str) -> bool {
    let v = value.trim_start().to_ascii_lowercase();
    v.starts_with("data:image/")
}

// ---------------------------------------------------------------- CSS scrub
//
// Whole declarations / at-rules are kept or dropped IN PLACE — original bytes
// are never rewritten, so legitimate escaped selectors can't be corrupted.
// Escape-decoding happens only on a throwaway copy used for matching, which
// closes the `\70osition: \66ixed` class of obfuscation. Strings and url()
// bodies are opaque to matching (bans can't fire on string content) and are
// emitted verbatim.

/// Scrub CSS text: a full stylesheet (from `<style>`) or a declaration block
/// (from a style="" attribute). Drops `position: fixed|sticky`, `@import`,
/// legacy CSS-execution vectors (expression(), behavior:, -moz-binding:), and
/// neuters selectors containing `:host`.
fn scrub_css(css: &str) -> String {
    let mut out = String::with_capacity(css.len());
    let mut chunk = String::new(); // original bytes of the current chunk
    let mut mask = String::new(); // match copy: comments/strings/urls masked

    let mut chars = css.char_indices().peekable();
    while let Some((i, c)) = chars.next() {
        match c {
            // comment: dropped from the match copy (acts as a separator),
            // kept in the emitted chunk (harmless once the chunk is kept)
            '/' if matches!(chars.peek(), Some((_, '*'))) => {
                chunk.push(c);
                let (_, star) = chars.next().unwrap();
                chunk.push(star);
                mask.push(' ');
                let mut prev = '\0';
                for (_, cc) in chars.by_ref() {
                    chunk.push(cc);
                    if prev == '*' && cc == '/' {
                        break;
                    }
                    prev = cc;
                }
            }
            '"' | '\'' => {
                chunk.push(c);
                mask.push('\u{1}');
                consume_string(&mut chars, &mut chunk, c);
            }
            // unquoted url( token — its body may legally contain ; { }
            'u' | 'U' if is_url_open(css, i) => {
                chunk.push(c);
                mask.push_str("url(");
                for (_, cc) in chars.by_ref() {
                    chunk.push(cc);
                    if cc == '(' {
                        break;
                    }
                }
                let mut esc = false;
                while let Some(&(_, cc)) = chars.peek() {
                    if esc {
                        esc = false;
                    } else if cc == '\\' {
                        esc = true;
                    } else if cc == '"' || cc == '\'' {
                        chars.next();
                        chunk.push(cc);
                        consume_string(&mut chars, &mut chunk, cc);
                        continue;
                    } else if cc == ')' {
                        chars.next();
                        chunk.push(cc);
                        mask.push(')');
                        break;
                    }
                    chars.next();
                    chunk.push(cc);
                }
            }
            '{' | '}' | ';' => {
                flush_chunk(&mut out, &mut chunk, &mut mask, Some(c));
            }
            _ => {
                chunk.push(c);
                mask.push(c);
            }
        }
    }
    flush_chunk(&mut out, &mut chunk, &mut mask, None);
    out
}

/// True when the text at byte offset `i` starts an unquoted `url(` token.
fn is_url_open(css: &str, i: usize) -> bool {
    css[i..].len() >= 4 && css[i..i + 4].eq_ignore_ascii_case("url(")
}

fn consume_string(
    chars: &mut std::iter::Peekable<std::str::CharIndices>,
    chunk: &mut String,
    quote: char,
) {
    let mut esc = false;
    for (_, cc) in chars.by_ref() {
        chunk.push(cc);
        if esc {
            esc = false;
        } else if cc == '\\' {
            esc = true;
        } else if cc == quote {
            break;
        }
    }
}

/// Emit, drop, or neuter the pending chunk, then the delimiter.
/// `{`-terminated chunks are selectors/preludes: never dropped (that would
/// orphan the block and unbalance braces) — `:host` reach-outs are replaced
/// with a selector that matches nothing. `;`/`}`/EOF-terminated chunks are
/// declaration or at-rule positions: dropped entirely when banned.
fn flush_chunk(out: &mut String, chunk: &mut String, mask: &mut String, delim: Option<char>) {
    let decoded = css_decode_for_match(mask);
    let d = decoded.trim();
    if delim == Some('{') {
        if d.contains(":host") {
            out.push_str("fm-x-neutered");
        } else {
            out.push_str(chunk);
        }
    } else {
        let banned = d.starts_with("@import") || is_banned_declaration(d);
        if !banned {
            out.push_str(chunk);
        } else if delim == Some(';') {
            // swallow the declaration AND its semicolon
            chunk.clear();
            mask.clear();
            return;
        }
    }
    if let Some(c) = delim {
        out.push(c);
    }
    chunk.clear();
    mask.clear();
}

fn is_banned_declaration(decoded: &str) -> bool {
    if contains_fn_call(decoded, "expression") {
        return true;
    }
    let Some((prop, value)) = decoded.split_once(':') else {
        return false;
    };
    match prop.trim() {
        "position" => contains_word(value, "fixed") || contains_word(value, "sticky"),
        "behavior" | "-moz-binding" => true,
        _ => false,
    }
}

/// `needle` present as a whole ident (not a substring of a longer one).
fn contains_word(hay: &str, needle: &str) -> bool {
    let mut start = 0;
    while let Some(pos) = hay[start..].find(needle) {
        let at = start + pos;
        let before = hay[..at].chars().next_back();
        let after = hay[at + needle.len()..].chars().next();
        let is_ident = |c: char| c.is_ascii_alphanumeric() || c == '-' || c == '_';
        if !before.is_some_and(is_ident) && !after.is_some_and(is_ident) {
            return true;
        }
        start = at + needle.len();
    }
    false
}

/// `needle(` with optional whitespace before the paren.
fn contains_fn_call(hay: &str, needle: &str) -> bool {
    let mut start = 0;
    while let Some(pos) = hay[start..].find(needle) {
        let at = start + pos;
        let before = hay[..at].chars().next_back();
        let is_ident = |c: char| c.is_ascii_alphanumeric() || c == '-' || c == '_';
        let rest = hay[at + needle.len()..].trim_start();
        if !before.is_some_and(is_ident) && rest.starts_with('(') {
            return true;
        }
        start = at + needle.len();
    }
    false
}

/// Decode CSS escapes for MATCHING only (never re-emitted): `\` + 1-6 hex
/// digits (+ one optional whitespace) → the codepoint; `\` + other char →
/// that char. Lowercases everything so matching is case-insensitive.
fn css_decode_for_match(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '\\' {
            out.extend(c.to_lowercase());
            continue;
        }
        let mut hex = String::new();
        while hex.len() < 6 {
            match chars.peek() {
                Some(h) if h.is_ascii_hexdigit() => {
                    hex.push(*h);
                    chars.next();
                }
                _ => break,
            }
        }
        if !hex.is_empty() {
            if let Some(ch) = u32::from_str_radix(&hex, 16).ok().and_then(char::from_u32) {
                out.extend(ch.to_lowercase());
            }
            if matches!(chars.peek(), Some(w) if w.is_whitespace()) {
                chars.next();
            }
        } else if let Some(ch) = chars.next() {
            out.extend(ch.to_lowercase());
        }
    }
    out
}

/// Run `scrub_css` over the text of every `<style>` element in ammonia's
/// serialized output (tag names are lowercase, attribute values double-quoted,
/// and the closing tag is exactly `</style>` — the serializer guarantees all
/// three).
fn scrub_style_elements(html: &str) -> String {
    let mut out = String::with_capacity(html.len());
    let mut rest = html;
    while let Some(start) = rest.find("<style") {
        // end of the open tag, honoring quoted attribute values
        let mut tag_end = None;
        let mut in_quote = false;
        for (i, c) in rest[start..].char_indices() {
            match c {
                '"' => in_quote = !in_quote,
                '>' if !in_quote => {
                    tag_end = Some(start + i);
                    break;
                }
                _ => {}
            }
        }
        let Some(tag_end) = tag_end else { break };
        let content_start = tag_end + 1;
        let Some(close) = rest[content_start..].find("</style>") else {
            break;
        };
        let content_end = content_start + close;
        out.push_str(&rest[..content_start]);
        out.push_str(&scrub_css(&rest[content_start..content_end]));
        out.push_str("</style>");
        rest = &rest[content_end + "</style>".len()..];
    }
    out.push_str(rest);
    out
}

/// Replace `cid:<id>` image sources with data: URIs where we have the bytes;
/// unresolved cids become empty sources (broken-image icon beats a leak).
fn resolve_cids(html: &str, cid_data: &HashMap<String, String>) -> String {
    if !html.contains("cid:") || cid_data.is_empty() {
        return html.to_string();
    }
    let mut out = html.to_string();
    for (cid, data_uri) in cid_data {
        // src="cid:xyz" | src='cid:xyz' — attribute quoting varies
        for quote in ['"', '\''] {
            let needle = format!("{quote}cid:{cid}{quote}");
            let replacement = format!("{quote}{data_uri}{quote}");
            out = out.replace(&needle, &replacement);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_scripts_and_handlers() {
        let dirty = r#"<div onclick="evil()"><script>evil()</script><p style="color:red">hi</p></div>"#;
        let clean = sanitize_email_html(dirty, &HashMap::new());
        assert!(!clean.contains("script"));
        assert!(!clean.contains("onclick"));
        assert!(clean.contains(r#"style="color:red""#));
    }

    #[test]
    fn keeps_tables_and_images() {
        let dirty = r##"<table width="600"><tr><td bgcolor="#fff"><img src="https://x.test/a.png" width="10"></td></tr></table>"##;
        let clean = sanitize_email_html(dirty, &HashMap::new());
        assert!(clean.contains("<table"));
        assert!(clean.contains(r#"src="https://x.test/a.png""#));
    }

    #[test]
    fn resolves_cid_images() {
        let mut cids = HashMap::new();
        cids.insert("logo@x".to_string(), "data:image/png;base64,AAAA".to_string());
        let dirty = r#"<img src="cid:logo@x">"#;
        let clean = sanitize_email_html(dirty, &cids);
        assert!(clean.contains("data:image/png;base64,AAAA"));
    }

    #[test]
    fn links_get_rel_and_javascript_urls_die() {
        let dirty = r#"<a href="javascript:evil()">x</a><a href="https://ok.test">y</a>"#;
        let clean = sanitize_email_html(dirty, &HashMap::new());
        assert!(!clean.contains("javascript:"));
        assert!(clean.contains("noopener"));
    }

    // ---- Inline-rendering hardening. The body now renders in a shadow root
    // ---- in the app document (no iframe sandbox), so this sanitizer is the
    // ---- sole trust boundary: everything the sandbox used to catch must
    // ---- die here, and <style> must survive for newsletters to lay out.

    #[test]
    fn keeps_style_elements_with_selectors_intact() {
        let dirty = r#"<style>.wrap > .col { color: red } @media (max-width:600px) { .col { width: 100% } }</style><div class="wrap"><p class="col">hi</p></div>"#;
        let clean = sanitize_email_html(dirty, &HashMap::new());
        assert!(clean.contains("<style>"), "{clean}");
        assert!(
            clean.contains(".wrap > .col"),
            "child combinator must not be HTML-escaped: {clean}"
        );
        assert!(clean.contains("@media"), "{clean}");
    }

    #[test]
    fn keeps_head_styles_and_class_id_attributes() {
        let dirty = r#"<html><head><style>.preheader { display: none }</style></head><body><div id="hero" class="preheader">preview text</div><p>body</p></body></html>"#;
        let clean = sanitize_email_html(dirty, &HashMap::new());
        assert!(
            clean.contains("display: none"),
            "a <style> in <head> must survive: {clean}"
        );
        assert!(clean.contains(r#"class="preheader""#), "{clean}");
        assert!(clean.contains(r#"id="hero""#), "{clean}");
    }

    #[test]
    fn scrubs_fixed_and_sticky_positioning() {
        let dirty = r#"<style>.o { position: fixed; top: 0 } .s { position:sticky } .k { position: relative }</style><div style="position:fixed;inset:0">x</div><p style="color:blue;position: FIXED">y</p>"#;
        let clean = sanitize_email_html(dirty, &HashMap::new()).to_lowercase();
        assert!(!clean.contains("fixed"), "{clean}");
        assert!(!clean.contains("sticky"), "{clean}");
        assert!(clean.contains("position: relative"), "{clean}");
        assert!(
            clean.contains("color:blue"),
            "unrelated declarations must survive: {clean}"
        );
    }

    #[test]
    fn scrubs_obfuscated_position_fixed() {
        // \70 = p, \66 = f; comments can pad the colon. CSS-escape tricks must
        // not smuggle a fixed overlay past the scrub.
        let dirty = r#"<style>.a { \70osition: fixed } .b { position/**/: /**/fixed } .c { position: \66 ixed }</style>"#;
        let clean = sanitize_email_html(dirty, &HashMap::new()).to_lowercase();
        assert!(!clean.contains("fixed"), "{clean}");
        assert!(!clean.contains("\\66"), "{clean}");
    }

    #[test]
    fn scrubs_import_and_legacy_css() {
        let dirty = r#"<style>@import url("https://evil.test/x.css"); .a { width: expression(alert(1)); behavior: url(x.htc); -moz-binding: url(b.xml); color: blue }</style>"#;
        let clean = sanitize_email_html(dirty, &HashMap::new()).to_lowercase();
        assert!(!clean.contains("@import"), "{clean}");
        assert!(!clean.contains("expression"), "{clean}");
        assert!(!clean.contains("behavior"), "{clean}");
        assert!(!clean.contains("-moz-binding"), "{clean}");
        assert!(clean.contains("color: blue"), "{clean}");
    }

    #[test]
    fn neuters_host_selectors() {
        // Email CSS lives inside the shadow root, so a :host rule could
        // restyle the host element and undo the containment jail.
        let dirty = r#"<style>:host { all: initial } :ho\73t, .x { color: red } .ok { color: green }</style>"#;
        let clean = sanitize_email_html(dirty, &HashMap::new());
        assert!(!clean.contains(":host"), "{clean}");
        assert!(!clean.contains("\\73"), "{clean}");
        assert!(clean.contains(".ok"), "{clean}");
    }

    #[test]
    fn strips_forms_and_controls() {
        let dirty = r#"<form action="https://evil.test/phish" method="post"><input name="card"><textarea>x</textarea><select><option>o</option></select><button type="submit">go</button></form><p>keep</p>"#;
        let clean = sanitize_email_html(dirty, &HashMap::new());
        for bad in ["<form", "<input", "<textarea", "<select", "<button", "action="] {
            assert!(!clean.contains(bad), "{bad} survived: {clean}");
        }
        assert!(clean.contains("keep"), "{clean}");
    }

    #[test]
    fn strips_frames_objects_meta_base() {
        let dirty = r#"<base href="https://evil.test/"><meta http-equiv="refresh" content="0;url=https://evil.test"><iframe src="https://evil.test"></iframe><object data="x"></object><embed src="y"><p>keep</p>"#;
        let clean = sanitize_email_html(dirty, &HashMap::new());
        for bad in ["<base", "<meta", "<iframe", "<object", "<embed"] {
            assert!(!clean.contains(bad), "{bad} survived: {clean}");
        }
        assert!(clean.contains("keep"), "{clean}");
    }

    #[test]
    fn data_urls_survive_only_as_image_sources() {
        let dirty = r#"<a href="data:text/html,<script>evil()</script>">x</a><img src="data:image/png;base64,AAAA"><img src="data:text/html,evil">"#;
        let clean = sanitize_email_html(dirty, &HashMap::new());
        assert!(!clean.contains("data:text/html"), "{clean}");
        assert!(clean.contains("data:image/png;base64,AAAA"), "{clean}");
    }

    #[test]
    fn background_attribute_is_scheme_checked() {
        let dirty = r#"<table><tr><td background="javascript:evil()">a</td><td background="https://x.test/bg.png">b</td></tr></table>"#;
        let clean = sanitize_email_html(dirty, &HashMap::new());
        assert!(!clean.contains("javascript:"), "{clean}");
        assert!(
            clean.contains(r#"background="https://x.test/bg.png""#),
            "{clean}"
        );
    }

    #[test]
    fn srcset_survives_only_with_https_urls() {
        let dirty = r#"<picture><source srcset="https://x.test/a.png 1x, https://x.test/b.png 2x" type="image/png"><img src="https://x.test/a.png"></picture><picture><source srcset="data:text/html,evil 1x"><img src="https://x.test/c.png"></picture>"#;
        let clean = sanitize_email_html(dirty, &HashMap::new());
        assert!(clean.contains("https://x.test/a.png 1x"), "{clean}");
        assert!(!clean.contains("data:text/html"), "{clean}");
    }

    #[test]
    fn style_text_cannot_break_out_of_its_element() {
        // A </style> inside a CSS string still ends the element at parse time;
        // whatever follows must be sanitized as markup, not smuggled through.
        let dirty = r#"<style>.a { background: url("</style><script>evil()</script>") }</style>"#;
        let clean = sanitize_email_html(dirty, &HashMap::new());
        assert!(!clean.contains("<script"), "{clean}");
        assert!(!clean.contains("evil()"), "{clean}");
    }

    #[test]
    fn css_strings_stay_opaque_and_unharmed() {
        // Bans must not fire on string CONTENT, and string bytes must survive
        // exactly (no escape-decoding corruption).
        let dirty = r#"<style>.q::before { content: "position:fixed \201C ;" ; color: teal }</style>"#;
        let clean = sanitize_email_html(dirty, &HashMap::new());
        assert!(clean.contains(r#""position:fixed \201C ;""#), "{clean}");
        assert!(clean.contains("color: teal"), "{clean}");
    }
}
