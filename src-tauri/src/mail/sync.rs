//! Pulls Gmail state into SQLite. The DB is the single source of truth for
//! the UI; sync reconciles it with the server.
use crate::mail::gmail::{parse_gmail_message, GmailSession};
use crate::store;
use crate::types::*;
use rusqlite::Connection;
use serde_json::Value;
use std::collections::HashSet;

/// Full reconcile of one account: INBOX + recent archived threads. Returns
/// true if anything changed (caller emits mail:updated).
pub async fn full_sync(
    http: &reqwest::Client,
    session: &mut GmailSession,
    db: &std::sync::Mutex<Connection>,
    account_id: &str,
) -> Result<bool, String> {
    let inbox = session.list_thread_ids(http, "in:inbox", 100).await?;
    let done = session
        .list_thread_ids(http, "-in:inbox -in:spam -in:trash -in:draft", 50)
        .await?;

    let inbox_ids: HashSet<&str> = inbox.iter().map(|(id, _)| id.as_str()).collect();
    let mut changed = false;

    // Which threads need a full fetch? New ones and ones whose historyId moved.
    let mut to_fetch: Vec<(String, bool)> = vec![]; // (id, in_inbox)
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
                to_fetch.push((id.clone(), inbox_ids.contains(id.as_str())));
            }
        }

        // Threads we think are in the inbox but the server no longer does
        // (archived elsewhere) — flip them locally.
        let local_inbox: Vec<String> = store::list_threads(&conn, "inbox", account_id)?
            .into_iter()
            .map(|t| t.id)
            .collect();
        for id in local_inbox {
            // mock-era ids (t-…) are never reconciled against Gmail
            if !id.starts_with("t-") && !inbox_ids.contains(id.as_str()) {
                store::set_in_inbox(&conn, &id, false)?;
                changed = true;
            }
        }
    }

    for (id, in_inbox) in to_fetch {
        let v = session.get_thread_full(http, &id).await?;
        let history_id = v["historyId"].as_str().unwrap_or_default().to_string();
        let (thread, msgs) = thread_from_json(&id, &v, in_inbox);
        {
            let conn = db.lock().unwrap();
            // A snoozed thread that grew a new message wakes up immediately.
            let existing = store::get_thread(&conn, &id);
            let was_snoozed = existing.as_ref().and_then(|t| t.snoozed_until).is_some();
            let grew = existing
                .map(|t| t.message_count < thread.message_count)
                .unwrap_or(false);
            store::upsert_thread(&conn, account_id, &thread, &msgs)?;
            if was_snoozed && !grew {
                // keep the local snooze: sync would otherwise resurface it
                conn.execute(
                    "UPDATE threads SET in_inbox = 0, snoozed_until = (SELECT snoozed_until FROM threads WHERE id = ?1) WHERE id = ?1",
                    [id.as_str()],
                )
                .map_err(|e| e.to_string())?;
            }
            conn.execute(
                "UPDATE threads SET history_id = ?2 WHERE id = ?1",
                rusqlite::params![id, history_id],
            )
            .map_err(|e| e.to_string())?;
        }
        changed = true;
    }

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
            .map(|(a, remote)| (a, remote, None))
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
