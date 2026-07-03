//! Pulls Gmail state into SQLite. The DB is the single source of truth for
//! the UI; sync reconciles it with the server.
//!
//! Two paths:
//! - **incremental** (normal): users.history.list since the stored per-account
//!   historyId — cheap, catches changes to any thread, no listing caps.
//! - **reconcile** (first sync / expired historyId): paged thread listings
//!   (inbox up to 500, recent archived up to 200) diffed by per-thread
//!   historyId, then the new baseline historyId is stored.
use crate::mail::gmail::{parse_gmail_message, GmailSession};
use crate::store;
use crate::types::*;
use rusqlite::Connection;
use serde_json::Value;
use std::collections::HashSet;

const INBOX_BACKFILL: usize = 500;
const DONE_BACKFILL: usize = 200;

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
    let prof = session.profile(http).await?;
    let baseline = prof["historyId"]
        .as_str()
        .map(str::to_string)
        .or_else(|| prof["historyId"].as_u64().map(|n| n.to_string()))
        .unwrap_or_default();

    let inbox = session
        .list_thread_ids_paged(http, "in:inbox", INBOX_BACKFILL)
        .await?;
    let done = session
        .list_thread_ids_paged(http, "-in:inbox -in:spam -in:trash -in:draft", DONE_BACKFILL)
        .await?;

    let inbox_ids: HashSet<&str> = inbox.iter().map(|(id, _)| id.as_str()).collect();
    let mut changed = false;

    // Which threads need a full fetch? New ones and ones whose historyId moved.
    let mut to_fetch: Vec<String> = vec![];
    {
        let conn = db.lock().unwrap();
        for (id, history_id) in inbox.iter().chain(done.iter()) {
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
        refetch_thread(http, session, db, account_id, &id).await?;
        changed = true;
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
    let (thread, msgs) = thread_from_json(id, &v, in_inbox);
    {
        let conn = db.lock().unwrap();
        // A snoozed thread that grew a new message wakes up immediately.
        let existing = store::get_thread(&conn, id);
        let was_snoozed = existing.as_ref().and_then(|t| t.snoozed_until).is_some();
        let grew = existing
            .map(|t| t.message_count < thread.message_count)
            .unwrap_or(false);
        store::upsert_thread(&conn, account_id, &thread, &msgs)?;
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
        msgs.push((parsed.message, parsed.rfc_message_id, parsed.list_unsubscribe, atts));
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
