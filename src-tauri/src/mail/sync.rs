//! Pulls Gmail state into SQLite. The DB is the single source of truth for
//! the UI; sync reconciles it with the server.
//!
//! Three paths:
//! - **incremental** (normal): users.history.list since the stored per-account
//!   historyId — cheap, catches changes to any thread, no listing caps.
//! - **reconcile** (first sync / expired historyId): paged thread listings
//!   (inbox up to 500, recent archived up to 200) diffed by per-thread
//!   historyId, then the new baseline historyId is stored.
//! - **crawl** (background): resumable full-history walk that fetches and
//!   FTS-indexes every thread past the backfill caps, one page per beat.
use crate::mail::gmail::{parse_gmail_message, GmailSession};
use crate::store;
use crate::types::*;
use rusqlite::Connection;
use serde_json::Value;
use std::collections::{HashMap, HashSet};

const INBOX_BACKFILL: usize = 500;
const DONE_BACKFILL: usize = 200;
const TRASH_BACKFILL: usize = 100;

fn history_key(account_id: &str) -> String {
    format!("history:{account_id}")
}

/// Sync one account. Returns true if anything changed (caller emits
/// mail:updated). `force_reconcile` ignores the stored historyId and does a full
/// listing pass — the periodic safety net that catches inbox removals the
/// incremental path missed.
pub async fn full_sync(
    http: &reqwest::Client,
    session: &mut GmailSession,
    db: &std::sync::Mutex<Connection>,
    account_id: &str,
    force_reconcile: bool,
) -> Result<bool, String> {
    let key = history_key(account_id);
    let start: Option<String> = if force_reconcile {
        None
    } else {
        let conn = db.lock().unwrap();
        store::get_json(&conn, &key)
    };
    let mut changed = match start {
        Some(hid) => match incremental(http, session, db, account_id, &hid, &key).await {
            Ok(c) => c,
            // An expired historyId (Gmail keeps ~a week) returns 404; an invalid
            // one returns 400. Either way reconcile from scratch instead of
            // pinning a dead baseline and re-failing the same window forever.
            Err(e) if e.contains("(404") || e.contains("(400") => {
                reconcile(http, session, db, account_id, &key).await?
            }
            Err(e) => return Err(e),
        },
        None => reconcile(http, session, db, account_id, &key).await?,
    };

    // Muted threads never sit in the inbox: any that resurfaced (new reply)
    // are re-archived, mirroring Gmail's mute semantics locally.
    let muted: Vec<String> = {
        let conn = db.lock().unwrap();
        store::muted_inbox_threads(&conn, account_id)
    };
    for id in muted {
        let _ = session.modify_thread(http, &id, &[], &["INBOX"]).await;
        let conn = db.lock().unwrap();
        store::set_in_inbox(&conn, &id, false)?;
        changed = true;
    }
    Ok(changed)
}

/// history.list-driven catch-up: collect affected thread ids, refetch those.
async fn incremental(
    http: &reqwest::Client,
    session: &mut GmailSession,
    db: &std::sync::Mutex<Connection>,
    account_id: &str,
    start_history_id: &str,
    key: &str,
) -> Result<bool, String> {
    let mut affected: HashSet<String> = HashSet::new();
    let mut latest = start_history_id.to_string();
    let mut page_token: Option<String> = None;
    let empty: Vec<Value> = vec![];
    loop {
        let v = session
            .history_page(http, start_history_id, page_token.as_deref())
            .await?; // 404 propagates to the caller for fallback
        if let Some(hid) = v["historyId"].as_str() {
            latest = hid.to_string();
        }
        for h in v["history"].as_array().unwrap_or(&empty) {
            for kind in ["messagesAdded", "messagesDeleted", "labelsAdded", "labelsRemoved"] {
                for entry in h[kind].as_array().unwrap_or(&empty) {
                    if let Some(tid) = entry["message"]["threadId"].as_str() {
                        affected.insert(tid.to_string());
                    }
                }
            }
        }
        page_token = v["nextPageToken"].as_str().map(str::to_string);
        if page_token.is_none() {
            break;
        }
    }

    let mut changed = false;
    for tid in &affected {
        match refetch_thread(http, session, db, account_id, tid).await {
            Ok(c) => changed |= c,
            // One thread failing (rate-limit, transient network, an unexpected
            // body) must NOT abort the loop — otherwise the advanced historyId
            // below is never stored, pinning the account to a stale window that
            // re-fails every cycle. Log it and keep going.
            Err(e) => eprintln!("[sync:{account_id}] refetch {tid} failed: {e}"),
        }
    }
    if latest != start_history_id {
        let conn = db.lock().unwrap();
        store::set_json(&conn, key, &latest)?;
    }
    Ok(changed)
}

/// Full listing pass; also the initial backfill. Stores the new baseline
/// historyId (captured BEFORE listing, so nothing in between is missed).
async fn reconcile(
    http: &reqwest::Client,
    session: &mut GmailSession,
    db: &std::sync::Mutex<Connection>,
    account_id: &str,
    key: &str,
) -> Result<bool, String> {
    // Captured BEFORE the listings so a thread the user trashes mid-reconcile
    // isn't mistaken for a server-side restore and resurrected below.
    let locally_trashed: Vec<String> = {
        let conn = db.lock().unwrap();
        store::trashed_thread_ids(&conn, account_id)
    };

    let prof = session.profile(http).await?;
    let baseline = prof["historyId"]
        .as_str()
        .map(str::to_string)
        .or_else(|| prof["historyId"].as_u64().map(|n| n.to_string()))
        .unwrap_or_default();

    // Refresh the label id→name map; older syncs stored opaque ids in
    // threads.labels, so repair those rows once the map is known.
    let mut changed = false;
    match session.list_labels(http).await {
        Ok(pairs) => {
            let conn = db.lock().unwrap();
            store::upsert_labels(&conn, account_id, &pairs)?;
            let map = store::label_map(&conn, account_id);
            changed |= store::rename_thread_labels(&conn, account_id, &map)?;
        }
        Err(e) => eprintln!("[sync:{account_id}] label listing failed: {e}"),
    }

    let inbox = session
        .list_thread_ids_paged(http, "in:inbox", INBOX_BACKFILL)
        .await?;
    let done = session
        .list_thread_ids_paged(http, "-in:inbox -in:spam -in:trash -in:draft", DONE_BACKFILL)
        .await?;
    let trash = session
        .list_thread_ids_paged(http, "in:trash", TRASH_BACKFILL)
        .await?;

    let inbox_ids: HashSet<&str> = inbox.iter().map(|(id, _)| id.as_str()).collect();
    let live_ids: HashSet<&str> =
        inbox.iter().chain(done.iter()).map(|(id, _)| id.as_str()).collect();
    let trash_ids: HashSet<&str> = trash.iter().map(|(id, _)| id.as_str()).collect();

    // Which threads need a full fetch? New ones and ones whose historyId moved.
    let mut to_fetch: Vec<String> = vec![];
    {
        let conn = db.lock().unwrap();
        for (id, history_id) in inbox.iter().chain(done.iter()).chain(trash.iter()) {
            let known: Option<String> = conn
                .query_row(
                    "SELECT COALESCE(history_id, '') FROM threads WHERE id = ?1",
                    [id.as_str()],
                    |r| r.get(0),
                )
                .ok();
            if known.as_deref() != Some(history_id.as_str()) {
                to_fetch.push(id.clone());
            }
        }

        // Threads we think are in the inbox but the server no longer does
        // (archived elsewhere) — flip them locally.
        let local_inbox: Vec<String> = store::list_threads(&conn, "inbox", account_id)?
            .into_iter()
            .map(|t| t.id)
            .collect();
        for id in local_inbox {
            // mock-era ids (t-… / t2-…) are never reconciled against Gmail
            if !id.starts_with("t-") && !id.starts_with("t2-") && !inbox_ids.contains(id.as_str()) {
                store::set_in_inbox(&conn, &id, false)?;
                changed = true;
            }
        }
    }

    for id in to_fetch {
        match refetch_thread(http, session, db, account_id, &id).await {
            Ok(_) => changed = true,
            // One poison thread must not abort the pass and skip storing the
            // baseline below — otherwise the account never advances off reconcile
            // and re-runs the full listing every cycle (same rationale as
            // incremental's log-and-continue).
            Err(e) => eprintln!("[sync:{account_id}] reconcile refetch {id} failed: {e}"),
        }
    }

    // Two-way trash: threads the server has in trash get hidden locally
    // (upsert never touches the hidden column), and threads restored on the
    // server side come back out. Gmail's "empty trash" deletes threads, which
    // the refetch 404 path above already drops.
    {
        let conn = db.lock().unwrap();
        for (id, _) in &trash {
            if store::get_thread(&conn, id).is_some()
                && store::hidden_reason(&conn, id).as_deref() != Some("trash")
            {
                store::set_hidden(&conn, id, Some("trash"))?;
                changed = true;
            }
        }
        // Restore only threads the server affirmatively lists live again —
        // absence from the (capped) trash listing alone isn't proof.
        for id in &locally_trashed {
            if !id.starts_with("t-")
                && !id.starts_with("t2-")
                && !trash_ids.contains(id.as_str())
                && live_ids.contains(id.as_str())
            {
                store::clear_hidden(&conn, id)?;
                changed = true;
            }
        }
    }

    if !baseline.is_empty() {
        let conn = db.lock().unwrap();
        store::set_json(&conn, key, &baseline)?;
    }
    Ok(changed)
}

/// Fetch one thread and apply it locally. Handles deletion (404 → drop the
/// local row), snooze preservation, and hidden threads. Returns true if the
/// local DB changed.
pub async fn refetch_thread(
    http: &reqwest::Client,
    session: &mut GmailSession,
    db: &std::sync::Mutex<Connection>,
    account_id: &str,
    id: &str,
) -> Result<bool, String> {
    let mut v = match session.get_thread_full(http, id).await {
        Ok(v) => v,
        Err(e) if e.contains("(404") => {
            // gone server-side (permanent delete) — drop it locally too
            let conn = db.lock().unwrap();
            let existed = store::get_thread(&conn, id).is_some();
            if existed {
                store::delete_thread(&conn, id)?;
            }
            return Ok(existed);
        }
        Err(e) => return Err(e),
    };

    // Pull in large text bodies stored behind body.attachmentId so the parse
    // below captures them (otherwise those messages persist an empty body).
    crate::mail::gmail::hydrate_body_data(http, session, &mut v).await;

    let history_id = v["historyId"].as_str().unwrap_or_default().to_string();
    let empty = vec![];
    let in_inbox = v["messages"]
        .as_array()
        .unwrap_or(&empty)
        .iter()
        .any(|m| {
            m["labelIds"]
                .as_array()
                .map(|ls| ls.iter().any(|l| l.as_str() == Some("INBOX")))
                .unwrap_or(false)
        });
    let (mut thread, msgs) = thread_from_json(id, &v, in_inbox);
    {
        let conn = db.lock().unwrap();
        // Gmail sends user labels as opaque ids — resolve them to display
        // names via the map persisted at reconcile (unknown ids pass through
        // until the next label listing catches up).
        let label_names = store::label_map(&conn, account_id);
        if !label_names.is_empty() {
            thread.labels = thread
                .labels
                .iter()
                .map(|l| label_names.get(l).unwrap_or(l).clone())
                .collect();
        }
        // A snoozed thread that grew a new message wakes up immediately.
        let existing = store::get_thread(&conn, id);
        let was_snoozed = existing.as_ref().and_then(|t| t.snoozed_until).is_some();
        // The local "Muted" marker is a display name; Gmail stores user labels as
        // opaque ids, so a refetch's labels=excluded.labels overwrites it. Remember
        // it and re-assert below so muted_inbox_threads keeps matching and new
        // replies to a muted thread are still auto-archived.
        let was_muted = existing
            .as_ref()
            .map(|t| t.labels.iter().any(|l| l == "Muted"))
            .unwrap_or(false);
        let grew = existing
            .as_ref()
            .map(|t| t.message_count < thread.message_count)
            .unwrap_or(false);
        store::upsert_thread(&conn, account_id, &thread, &msgs)?;
        if was_muted {
            let _ = store::toggle_label(&conn, id, "Muted");
        }
        if was_snoozed && !grew {
            // keep the local snooze: sync would otherwise resurface it
            conn.execute(
                "UPDATE threads SET in_inbox = 0, snoozed_until = (SELECT snoozed_until FROM threads WHERE id = ?1) WHERE id = ?1",
                [id],
            )
            .map_err(|e| e.to_string())?;
        }
        conn.execute(
            "UPDATE threads SET history_id = ?2 WHERE id = ?1",
            rusqlite::params![id, history_id],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(true)
}

pub fn thread_from_json(id: &str, v: &Value, in_inbox: bool) -> (Thread, Vec<store::MsgRow>) {
    let empty = vec![];
    let raw_msgs = v["messages"].as_array().unwrap_or(&empty);
    let mut msgs: Vec<store::MsgRow> = vec![];
    let mut participants: Vec<String> = vec![];
    let mut labels: HashSet<String> = HashSet::new();
    let mut unread = false;
    let mut last_date = 0i64;
    let mut subject = String::new();
    let mut snippet = String::new();

    for m in raw_msgs {
        let parsed = parse_gmail_message(m, id);
        for l in &parsed.label_ids {
            labels.insert(l.clone());
        }
        unread |= parsed.message.unread;
        if parsed.message.date >= last_date {
            last_date = parsed.message.date;
            snippet = parsed.message.snippet.clone();
        }
        if subject.is_empty() && !parsed.message.subject.is_empty() {
            subject = parsed.message.subject.clone();
        }
        let p = format!("{} <{}>", parsed.message.from_name, parsed.message.from);
        if !participants.contains(&p) {
            participants.push(p);
        }
        let atts = parsed
            .attachments
            .into_iter()
            .map(|(a, remote, content_id)| (a, remote, content_id, None))
            .collect();
        msgs.push((parsed.message, parsed.rfc_message_id, parsed.list_unsubscribe, parsed.ics, atts));
    }

    let starred = labels.contains("STARRED");
    let thread = Thread {
        id: id.to_string(),
        subject: if subject.is_empty() { "(no subject)".into() } else { subject },
        snippet,
        participants,
        message_count: msgs.len() as i64,
        last_date,
        unread,
        starred,
        labels: labels
            .into_iter()
            .filter(|l| l != "INBOX" && l != "UNREAD" && l != "STARRED" && !l.starts_with("CATEGORY_"))
            .collect(),
        in_inbox,
        snoozed_until: None,
    };
    (thread, msgs)
}

// ------------------------------------------------------------------ crawl
//
// Background full-history search indexing. reconcile() caps its listings, so
// mail older than the caps never entered mail_fts and the first search for it
// paid a live Gmail round-trip. The crawl walks the whole mailbox once,
// newest to oldest, one listing page per beat, fetching + indexing whatever
// isn't local yet. The cursor lives in kv so the walk survives restarts, and
// re-anchors with before: when a persisted page token expires. Once done,
// incremental sync keeps the index current — done is terminal.

/// Gmail's default search scope (no spam/trash), minus drafts — the same
/// population local search exposes (`hidden IS NULL`, reconcile skips drafts).
const CRAWL_QUERY: &str = "-in:spam -in:trash -in:draft";
/// Pause between thread fetches: ≤5 req/s keeps a crawling account far under
/// Gmail's per-user quota (threads.get = 10 units of 15,000/min).
const CRAWL_THROTTLE_MS: u64 = 200;
/// Re-anchor overlap: a day of re-listed (and then history_id-skipped)
/// threads absorbs before:'s coarse granularity at the boundary.
const ANCHOR_OVERLAP_SECS: i64 = 86_400;

fn crawl_key(account_id: &str) -> String {
    format!("crawl:{account_id}")
}

/// Persisted crawl position (kv: crawl:<account>).
#[derive(serde::Serialize, serde::Deserialize, Clone, Default, Debug, PartialEq)]
pub struct CrawlCursor {
    /// Next listing page. None at the start of a (re-)listing.
    #[serde(default)]
    pub page_token: Option<String>,
    /// Unix seconds the current listing is anchored at (`before:anchor`);
    /// None = listing from the newest thread.
    #[serde(default)]
    pub anchor: Option<i64>,
    /// Oldest thread date (ms) seen so far — the next anchor if the page
    /// token expires.
    #[serde(default)]
    pub oldest_ms: Option<i64>,
    /// Threads fetched + indexed by the crawl (progress logging).
    #[serde(default)]
    pub indexed: u64,
    /// Whole history walked; nothing left to do.
    #[serde(default)]
    pub done: bool,
}

fn crawl_query(anchor: Option<i64>) -> String {
    match anchor {
        Some(secs) => format!("{CRAWL_QUERY} before:{secs}"),
        None => CRAWL_QUERY.to_string(),
    }
}

/// A dead page token can't be resumed — restart the listing just past the
/// oldest indexed thread (or from the top if nothing was indexed yet).
fn reanchor(cur: &mut CrawlCursor) {
    cur.page_token = None;
    cur.anchor = cur.oldest_ms.map(|ms| ms / 1000 + ANCHOR_OVERLAP_SECS);
}

/// What one crawl beat did, for the caller's log line.
pub struct CrawlBeat {
    pub fetched: usize,
    pub skipped: usize,
    pub failed: usize,
    pub total_indexed: u64,
    pub done: bool,
}

/// One beat of the crawl: process a single listing page (≤100 threads), then
/// persist the advanced cursor. Locks the session map per call — never across
/// the whole beat — so user-triggered Gmail traffic interleaves with a crawl.
pub async fn crawl_step(
    http: &reqwest::Client,
    gmail: &tokio::sync::Mutex<HashMap<String, GmailSession>>,
    db: &std::sync::Mutex<Connection>,
    account_id: &str,
) -> Result<CrawlBeat, String> {
    let key = crawl_key(account_id);
    let mut cur: CrawlCursor = {
        let conn = db.lock().unwrap();
        store::get_json(&conn, &key).unwrap_or_default()
    };
    if cur.done {
        return Ok(CrawlBeat {
            fetched: 0,
            skipped: 0,
            failed: 0,
            total_indexed: cur.indexed,
            done: true,
        });
    }

    let query = crawl_query(cur.anchor);
    let listed = {
        let mut sessions = gmail.lock().await;
        let Some(session) = sessions.get_mut(account_id) else {
            return Err("account disconnected".into());
        };
        session.list_threads_page(http, &query, cur.page_token.as_deref()).await
    };
    let (page, next) = match listed {
        Ok(v) => v,
        // Gmail 400s a stale page token; retrying it is hopeless. Re-anchor
        // and continue from the oldest indexed thread on the next beat.
        Err(e) if e.contains("(400") && cur.page_token.is_some() => {
            reanchor(&mut cur);
            let conn = db.lock().unwrap();
            store::set_json(&conn, &key, &cur)?;
            return Err(format!(
                "page token expired; re-anchored at before:{:?}",
                cur.anchor
            ));
        }
        Err(e) => return Err(e), // transient — same cursor retries next beat
    };

    let mut beat = CrawlBeat {
        fetched: 0,
        skipped: 0,
        failed: 0,
        total_indexed: cur.indexed,
        done: false,
    };
    let mut page_oldest: Option<i64> = None;
    for (id, history_id) in &page {
        let known: Option<String> = {
            let conn = db.lock().unwrap();
            conn.query_row(
                "SELECT COALESCE(history_id, '') FROM threads WHERE id = ?1",
                [id.as_str()],
                |r| r.get(0),
            )
            .ok()
        };
        if known.as_deref() == Some(history_id.as_str()) {
            beat.skipped += 1;
        } else {
            let fetched = {
                let mut sessions = gmail.lock().await;
                let Some(session) = sessions.get_mut(account_id) else {
                    return Err("account disconnected mid-beat".into());
                };
                refetch_thread(http, session, db, account_id, id).await
            };
            match fetched {
                Ok(_) => beat.fetched += 1,
                // One bad thread must not wedge the walk — log it and move
                // on; the live search_all path can still surface it.
                Err(e) => {
                    beat.failed += 1;
                    eprintln!("[crawl:{account_id}] deferred {id}: {e}");
                }
            }
            tokio::time::sleep(std::time::Duration::from_millis(CRAWL_THROTTLE_MS)).await;
        }
        let date: Option<i64> = {
            let conn = db.lock().unwrap();
            conn.query_row("SELECT last_date FROM threads WHERE id = ?1", [id.as_str()], |r| {
                r.get(0)
            })
            .ok()
        };
        if let Some(d) = date {
            page_oldest = Some(page_oldest.map_or(d, |o| o.min(d)));
        }
    }

    // Every fetch failing looks like an outage, not poison threads — keep the
    // cursor unchanged so the same page retries instead of holing the index.
    if beat.fetched == 0 && beat.failed > 0 {
        return Err(format!("all {} fetches failed; page will retry", beat.failed));
    }

    if let Some(d) = page_oldest {
        cur.oldest_ms = Some(cur.oldest_ms.map_or(d, |o| o.min(d)));
    }
    cur.indexed += beat.fetched as u64;
    cur.page_token = next;
    if cur.page_token.is_none() {
        cur.done = true; // listing exhausted: full history is indexed
    }
    beat.total_indexed = cur.indexed;
    beat.done = cur.done;
    {
        let conn = db.lock().unwrap();
        store::set_json(&conn, &key, &cur)?;
    }
    Ok(beat)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn crawl_query_anchors_with_before() {
        assert_eq!(crawl_query(None), "-in:spam -in:trash -in:draft");
        assert_eq!(
            crawl_query(Some(1_700_000_000)),
            "-in:spam -in:trash -in:draft before:1700000000"
        );
    }

    #[test]
    fn crawl_cursor_roundtrips_through_kv() {
        let conn = store::open(std::path::Path::new(":memory:")).unwrap();
        let cur = CrawlCursor {
            page_token: Some("tok123".into()),
            anchor: Some(1_700_000_000),
            oldest_ms: Some(1_699_999_999_000),
            indexed: 4200,
            done: false,
        };
        store::set_json(&conn, &crawl_key("a@b.c"), &cur).unwrap();
        let back: CrawlCursor = store::get_json(&conn, &crawl_key("a@b.c")).unwrap();
        assert_eq!(back, cur);
        // a fresh account has no cursor row → the crawl starts from default
        let missing: Option<CrawlCursor> = store::get_json(&conn, &crawl_key("new@b.c"));
        assert!(missing.is_none());
    }

    #[test]
    fn reanchor_restarts_past_oldest_indexed() {
        let mut cur = CrawlCursor {
            page_token: Some("stale".into()),
            anchor: None,
            oldest_ms: Some(1_699_999_999_123),
            indexed: 7,
            done: false,
        };
        reanchor(&mut cur);
        assert_eq!(cur.page_token, None);
        assert_eq!(cur.anchor, Some(1_699_999_999 + ANCHOR_OVERLAP_SECS));

        // token expired before anything was indexed → restart from the top
        let mut fresh = CrawlCursor { page_token: Some("stale".into()), ..Default::default() };
        reanchor(&mut fresh);
        assert_eq!(fresh.anchor, None);
        assert_eq!(fresh.page_token, None);
    }
}
