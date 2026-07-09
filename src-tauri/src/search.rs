//! Query planning: one parsed shape routes local search (FTS / contact /
//! date-window) and the remote Gmail fallback. The deterministic parser
//! understands Gmail operators (from:/to:/after:/before:, quoted phrases);
//! natural-language phrasings ("invoices from jane last week") go through
//! the configured AI provider in search_all, falling back to the
//! deterministic parse whenever the provider is missing, slow, or wrong.

/// after is inclusive, before exclusive — both local-midnight ms.
#[derive(Debug, Default, Clone, PartialEq)]
pub struct SearchPlan {
    pub people: Vec<String>,
    pub terms: Vec<String>,
    pub after: Option<i64>,
    pub before: Option<i64>,
}

impl SearchPlan {
    pub fn is_empty(&self) -> bool {
        self.people.is_empty() && self.terms.is_empty() && self.after.is_none() && self.before.is_none()
    }
}

/// Whitespace tokens, except inside double quotes — `from:"maya chen"` and
/// `"board deck"` each stay one token (quotes preserved).
fn tokenize(q: &str) -> Vec<String> {
    let mut out = vec![];
    let mut cur = String::new();
    let mut in_quotes = false;
    for c in q.chars() {
        match c {
            '"' => {
                in_quotes = !in_quotes;
                cur.push('"');
            }
            c if c.is_whitespace() && !in_quotes => {
                if !cur.is_empty() {
                    out.push(std::mem::take(&mut cur));
                }
            }
            c => cur.push(c),
        }
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    out
}

fn unquote(s: &str) -> String {
    s.trim_matches('"').trim().to_string()
}

/// `word:rest` where word is alphabetic — an operator token. Everything the
/// local store can't honor (has:, in:, label:, is:, …) is dropped from the
/// local plan; the raw query still reaches Gmail on the remote pass.
fn is_operator(tok: &str) -> bool {
    tok.split_once(':')
        .map(|(w, _)| !w.is_empty() && w.chars().all(|c| c.is_ascii_alphabetic()))
        .unwrap_or(false)
}

fn parse_date(s: &str) -> Option<chrono::NaiveDate> {
    let s = unquote(s);
    chrono::NaiveDate::parse_from_str(&s, "%Y/%m/%d")
        .or_else(|_| chrono::NaiveDate::parse_from_str(&s, "%Y-%m-%d"))
        .ok()
}

/// Local midnight in ms — matches how a user reads "after: March 1st".
fn day_start_ms(d: chrono::NaiveDate) -> i64 {
    let t = d.and_hms_opt(0, 0, 0).expect("midnight is always valid");
    t.and_local_timezone(chrono::Local)
        .earliest()
        .map(|z| z.timestamp_millis())
        .unwrap_or_else(|| t.and_utc().timestamp_millis())
}

/// Operator-aware parse — replaces the old strip-everything sanitizer, so
/// `from:jane after:2026/03/01 invoice` routes instead of degenerating into
/// the term "fromjane".
pub fn parse_deterministic(query: &str) -> SearchPlan {
    let mut plan = SearchPlan::default();
    for tok in tokenize(query) {
        let lower = tok.to_lowercase();
        if let Some(v) = lower.strip_prefix("from:").or_else(|| lower.strip_prefix("to:")) {
            let person = unquote(v);
            if !person.is_empty() {
                plan.people.push(person);
            }
        } else if let Some(v) = lower.strip_prefix("after:") {
            plan.after = parse_date(v).map(day_start_ms);
        } else if let Some(v) = lower.strip_prefix("before:") {
            plan.before = parse_date(v).map(day_start_ms);
        } else if is_operator(&lower) {
            // Gmail-only operator — remote pass handles it; nothing local.
        } else {
            let term = unquote(&lower);
            if !term.is_empty() {
                plan.terms.push(term);
            }
        }
    }
    plan
}

/// AI parsing is worth a provider round-trip only for multi-word queries
/// with no explicit operators — operator queries already speak Gmail.
pub fn looks_natural(query: &str) -> bool {
    let toks = tokenize(query);
    toks.len() >= 2 && !toks.iter().any(|t| is_operator(&t.to_lowercase()))
}

pub fn ai_system_prompt(today_local: &str) -> String {
    format!(
        "You parse email search queries into a routing plan. Today is {today_local}.\n\
         Reply with ONLY this JSON shape, no prose:\n\
         {{\"people\":[],\"terms\":[],\"after\":null,\"before\":null}}\n\
         Rules:\n\
         - people: names or email addresses of senders/recipients the query mentions.\n\
         - terms: content keywords to full-text match. Exclude people, time words, and \
         filler words like \"emails\", \"messages\", \"from\", \"about\".\n\
         - after/before: \"YYYY-MM-DD\" bounds implied by time phrases (\"last week\", \
         \"in March\"); before is exclusive; null when the query has no time constraint.\n\
         - Keep every list short (4 items or fewer)."
    )
}

/// Extract a SearchPlan from a model response (tolerates prose around the
/// JSON). None = unusable → caller falls back to the deterministic parse.
pub fn parse_ai_plan(raw: &str) -> Option<SearchPlan> {
    #[derive(serde::Deserialize, Default)]
    struct Wire {
        #[serde(default)]
        people: Vec<String>,
        #[serde(default)]
        terms: Vec<String>,
        #[serde(default)]
        after: Option<String>,
        #[serde(default)]
        before: Option<String>,
    }
    let s = raw.find('{')?;
    let e = raw.rfind('}')?;
    if e <= s {
        return None;
    }
    let w: Wire = serde_json::from_str(&raw[s..=e]).ok()?;
    let clip = |v: Vec<String>| -> Vec<String> {
        v.into_iter()
            .map(|s| s.trim().to_lowercase())
            .filter(|s| !s.is_empty() && s.len() <= 60)
            .take(4)
            .collect()
    };
    let plan = SearchPlan {
        people: clip(w.people),
        terms: clip(w.terms),
        after: w.after.as_deref().and_then(parse_date).map(day_start_ms),
        before: w.before.as_deref().and_then(parse_date).map(day_start_ms),
    };
    if plan.is_empty() {
        None
    } else {
        Some(plan)
    }
}

fn gmail_date(ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ms)
        .map(|t| t.with_timezone(&chrono::Local).format("%Y/%m/%d").to_string())
        .unwrap_or_default()
}

/// Rebuild an AI plan as Gmail operator syntax for the remote pass —
/// "invoices from jane last week" searches better as
/// `invoice (from:jane OR to:jane) after:… before:…` than as raw prose.
pub fn to_remote_query(plan: &SearchPlan) -> String {
    let quote = |s: &str| {
        if s.contains(' ') {
            format!("\"{s}\"")
        } else {
            s.to_string()
        }
    };
    let mut parts: Vec<String> = plan.terms.iter().map(|t| quote(t)).collect();
    for p in &plan.people {
        parts.push(format!("(from:{q} OR to:{q})", q = quote(p)));
    }
    if let Some(ms) = plan.after {
        parts.push(format!("after:{}", gmail_date(ms)));
    }
    if let Some(ms) = plan.before {
        parts.push(format!("before:{}", gmail_date(ms)));
    }
    parts.join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn operators_route_instead_of_degenerating() {
        let p = parse_deterministic("from:maya budget after:2026/03/01 before:2026-04-01");
        assert_eq!(p.people, vec!["maya"]);
        assert_eq!(p.terms, vec!["budget"]);
        assert_eq!(p.after, Some(day_start_ms(chrono::NaiveDate::from_ymd_opt(2026, 3, 1).unwrap())));
        assert_eq!(p.before, Some(day_start_ms(chrono::NaiveDate::from_ymd_opt(2026, 4, 1).unwrap())));
    }

    #[test]
    fn quoted_phrases_and_quoted_people_stay_whole() {
        let p = parse_deterministic("\"board deck\" review from:\"maya chen\"");
        assert_eq!(p.terms, vec!["board deck", "review"]);
        assert_eq!(p.people, vec!["maya chen"]);
    }

    #[test]
    fn unsupported_operators_drop_locally() {
        let p = parse_deterministic("has:attachment roadmap in:anywhere");
        assert_eq!(p.terms, vec!["roadmap"]);
        assert!(p.people.is_empty());
    }

    #[test]
    fn natural_language_detection() {
        assert!(looks_natural("invoices from jane last week"));
        assert!(!looks_natural("roadmap")); // single term: FTS is enough
        assert!(!looks_natural("from:jane invoice")); // already speaks Gmail
    }

    #[test]
    fn ai_plan_parses_with_prose_and_falls_back_on_garbage() {
        let raw = "Sure! Here is the plan:\n{\"people\":[\"Jane Doe\"],\"terms\":[\"Invoice\"],\"after\":\"2026-07-01\",\"before\":null}\nHope that helps.";
        let p = parse_ai_plan(raw).unwrap();
        assert_eq!(p.people, vec!["jane doe"]);
        assert_eq!(p.terms, vec!["invoice"]);
        assert!(p.after.is_some() && p.before.is_none());
        assert!(parse_ai_plan("no json here").is_none());
        assert!(parse_ai_plan("{\"people\":[],\"terms\":[]}").is_none()); // empty plan is useless
    }

    #[test]
    fn remote_query_rebuilds_operator_syntax() {
        let plan = SearchPlan {
            people: vec!["jane doe".into()],
            terms: vec!["invoice".into()],
            after: Some(day_start_ms(chrono::NaiveDate::from_ymd_opt(2026, 7, 1).unwrap())),
            before: None,
        };
        let q = to_remote_query(&plan);
        assert_eq!(q, "invoice (from:\"jane doe\" OR to:\"jane doe\") after:2026/07/01");
    }
}
