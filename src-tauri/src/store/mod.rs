//! SQLite persistence: threads/messages/attachments, JSON settings blobs,
//! and an FTS5 index for instant full-text search.
use crate::types::*;
use rusqlite::{params, Connection};
use std::collections::HashMap;

pub fn open(path: &std::path::Path) -> Result<Connection, String> {
    let conn = Connection::open(path).map_err(|e| e.to_string())?;
    conn.execute_batch(
        r#"
        PRAGMA journal_mode = WAL;
        PRAGMA foreign_keys = ON;

        CREATE TABLE IF NOT EXISTS threads (
            id TEXT PRIMARY KEY,
            subject TEXT NOT NULL DEFAULT '',
            snippet TEXT NOT NULL DEFAULT '',
            participants TEXT NOT NULL DEFAULT '[]',
            message_count INTEGER NOT NULL DEFAULT 0,
            last_date INTEGER NOT NULL DEFAULT 0,
            unread INTEGER NOT NULL DEFAULT 0,
            starred INTEGER NOT NULL DEFAULT 0,
            labels TEXT NOT NULL DEFAULT '[]',
            in_inbox INTEGER NOT NULL DEFAULT 1,
            snoozed_until INTEGER,
            history_id TEXT
        );

        CREATE TABLE IF NOT EXISTS messages (
            id TEXT PRIMARY KEY,
            thread_id TEXT NOT NULL,
            from_addr TEXT NOT NULL DEFAULT '',
            from_name TEXT NOT NULL DEFAULT '',
            to_addrs TEXT NOT NULL DEFAULT '[]',
            cc_addrs TEXT NOT NULL DEFAULT '[]',
            subject TEXT NOT NULL DEFAULT '',
            snippet TEXT NOT NULL DEFAULT '',
            body_text TEXT NOT NULL DEFAULT '',
            body_html TEXT,
            date INTEGER NOT NULL DEFAULT 0,
            unread INTEGER NOT NULL DEFAULT 0,
            rfc_message_id TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id);

        CREATE TABLE IF NOT EXISTS attachments (
            id TEXT PRIMARY KEY,
            message_id TEXT NOT NULL,
            filename TEXT NOT NULL,
            mime_type TEXT NOT NULL,
            size_bytes INTEGER NOT NULL DEFAULT 0,
            remote_id TEXT,
            text_content TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_attachments_message ON attachments(message_id);

        CREATE TABLE IF NOT EXISTS kv (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );

        CREATE VIRTUAL TABLE IF NOT EXISTS mail_fts USING fts5(
            thread_id UNINDEXED,
            subject,
            from_text,
            body
        );
        "#,
    )
    .map_err(|e| e.to_string())?;

    // v0.2 migration: per-account mail. Errors mean the column already exists.
    let _ = conn.execute(
        "ALTER TABLE threads ADD COLUMN account_id TEXT NOT NULL DEFAULT 'demo@zenbox.local'",
        [],
    );
    Ok(conn)
}

pub const DEMO_ACCOUNT: &str = "demo@zenbox.local";
pub const DEMO_ACCOUNT_2: &str = "angel@zenbox.local";

pub fn get_accounts(conn: &Connection) -> AccountsState {
    if let Some(state) = get_json::<AccountsState>(conn, "accounts") {
        if !state.accounts.is_empty() {
            return state;
        }
    }
    // migrate v0.1's single-account kv, else fall back to the demo pair
    if let Some(old) = get_json::<AccountInfo>(conn, "account") {
        if old.provider == "gmail" {
            let state = AccountsState { active: old.email.clone(), accounts: vec![old] };
            let _ = set_json(conn, "accounts", &state);
            return state;
        }
    }
    AccountsState {
        accounts: vec![
            AccountInfo { email: DEMO_ACCOUNT.into(), provider: "mock".into(), connected: true },
            AccountInfo { email: DEMO_ACCOUNT_2.into(), provider: "mock".into(), connected: true },
        ],
        active: DEMO_ACCOUNT.into(),
    }
}

pub fn save_accounts(conn: &Connection, state: &AccountsState) -> Result<(), String> {
    set_json(conn, "accounts", state)
}

// ---------------------------------------------------------------- kv (JSON)

pub fn get_json<T: serde::de::DeserializeOwned>(conn: &Connection, key: &str) -> Option<T> {
    conn.query_row("SELECT value FROM kv WHERE key = ?1", params![key], |r| {
        r.get::<_, String>(0)
    })
    .ok()
    .and_then(|s| serde_json::from_str(&s).ok())
}

pub fn set_json<T: serde::Serialize>(conn: &Connection, key: &str, value: &T) -> Result<(), String> {
    let s = serde_json::to_string(value).map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO kv(key, value) VALUES(?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, s],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

// ---------------------------------------------------------------- defaults

pub fn default_settings() -> Settings {
    let mut shortcuts = HashMap::new();
    for (k, v) in [
        ("palette.open", "mod+k"),
        ("compose", "c"),
        ("thread.done", "e"),
        ("thread.snooze", "h"),
        ("thread.reply", "r"),
        ("thread.forward", "f"),
        ("thread.replyAllOrOpen", "enter"),
        ("list.next", "j|down"),
        ("list.prev", "k|up"),
        ("thread.unread", "u"),
        ("thread.move", "v"),
        ("thread.replyAll", "a"),
        ("thread.star", "s"),
        ("thread.trash", "#"),
        ("thread.notDone", "shift+e"),
        ("search", "/"),
        ("ai.ask", "?"),
        ("split.next", "tab"),
        ("split.prev", "shift+tab"),
        ("goto.inbox", "g i"),
        ("goto.other", "g o"),
        ("goto.done", "g e"),
        ("goto.reminders", "g h"),
        ("compose.ai", "mod+j"),
        ("compose.send", "mod+enter"),
        ("compose.sendDone", "mod+shift+enter"),
        ("thread.cycleSuggestion", "tab"),
        ("back", "escape"),
        ("inbox.zeroSweep", ""),
        ("sync.now", ""),
        ("settings.open", "mod+,"),
        ("account.1", "mod+1"),
        ("account.2", "mod+2"),
        ("account.3", "mod+3"),
        ("account.4", "mod+4"),
        ("account.5", "mod+5"),
        ("account.6", "mod+6"),
        ("account.7", "mod+7"),
        ("account.8", "mod+8"),
        ("account.9", "mod+9"),
    ] {
        shortcuts.insert(k.to_string(), v.to_string());
    }
    Settings {
        splits: vec![
            Split {
                id: "important".into(),
                name: "Important".into(),
                builtin: true,
                rules: vec![SplitRule { field: "label".into(), contains: "IMPORTANT".into() }],
                op: "or".into(),
                hide_when_empty: false,
            },
            Split {
                id: "other".into(),
                name: "Other".into(),
                builtin: true,
                rules: vec![],
                op: "or".into(),
                hide_when_empty: false,
            },
            Split {
                id: "calendar".into(),
                name: "Calendar".into(),
                builtin: true,
                rules: vec![
                    SplitRule { field: "label".into(), contains: "CALENDAR".into() },
                    SplitRule { field: "subject".into(), contains: "Invitation:".into() },
                    SplitRule { field: "from".into(), contains: "calendar-invite".into() },
                ],
                op: "or".into(),
                hide_when_empty: false,
            },
        ],
        // NIM/DeepSeek is the default because it's the key the user supplied;
        // switch to Claude/OpenAI any time in Settings.
        default_ai_provider: "nim".into(),
        providers: vec![
            AiProviderConfig {
                id: "claude".into(),
                label: "Claude".into(),
                model: "claude-sonnet-5".into(),
                base_url: None,
                has_key: false,
            },
            AiProviderConfig {
                id: "openai".into(),
                label: "OpenAI".into(),
                model: "gpt-5.2".into(),
                base_url: None,
                has_key: false,
            },
            AiProviderConfig {
                id: "nim".into(),
                label: "NVIDIA NIM".into(),
                model: "deepseek-ai/deepseek-v4-pro".into(),
                base_url: Some("https://integrate.api.nvidia.com/v1".into()),
                has_key: false,
            },
        ],
        celebration_dir: None,
        shortcuts,
        signatures: HashMap::new(),
    }
}

/// Saved settings merged with defaults, so upgrades gain new shortcuts and
/// providers without wiping user customization. `has_key` always reflects
/// the keychain, not a stored flag (keys can be seeded/removed out-of-band).
pub fn get_settings(conn: &Connection) -> Settings {
    let defaults = default_settings();
    let mut s = match get_json::<Settings>(conn, "settings") {
        None => defaults,
        Some(mut s) => {
            for (k, v) in defaults.shortcuts {
                s.shortcuts.entry(k).or_insert(v);
            }
            for p in defaults.providers {
                if !s.providers.iter().any(|x| x.id == p.id) {
                    s.providers.push(p);
                }
            }
            s
        }
    };
    for p in s.providers.iter_mut() {
        if let Some(entry) = crate::secrets::ai_key_entry(&p.id) {
            p.has_key = crate::secrets::get(entry).is_some();
        }
    }
    s
}

pub fn get_kb(conn: &Connection) -> KnowledgeBase {
    get_json(conn, "kb").unwrap_or(KnowledgeBase {
        instructions: String::new(),
        snippets: vec![],
        voice_examples: vec![],
    })
}

pub fn get_streaks(conn: &Connection) -> Streaks {
    get_json(conn, "streaks").unwrap_or(Streaks { daily: 0, weekly: 0, last_zero_day: None })
}

pub fn active_account(conn: &Connection) -> AccountInfo {
    let state = get_accounts(conn);
    state
        .accounts
        .iter()
        .find(|a| a.email == state.active)
        .cloned()
        .unwrap_or_else(|| state.accounts[0].clone())
}

// ---------------------------------------------------------------- rows

fn row_to_thread(r: &rusqlite::Row) -> rusqlite::Result<Thread> {
    Ok(Thread {
        id: r.get(0)?,
        subject: r.get(1)?,
        snippet: r.get(2)?,
        participants: serde_json::from_str(&r.get::<_, String>(3)?).unwrap_or_default(),
        message_count: r.get(4)?,
        last_date: r.get(5)?,
        unread: r.get::<_, i64>(6)? != 0,
        starred: r.get::<_, i64>(7)? != 0,
        labels: serde_json::from_str(&r.get::<_, String>(8)?).unwrap_or_default(),
        in_inbox: r.get::<_, i64>(9)? != 0,
        snoozed_until: r.get(10)?,
    })
}

const THREAD_COLS: &str = "id, subject, snippet, participants, message_count, last_date, unread, starred, labels, in_inbox, snoozed_until";

pub fn list_threads(conn: &Connection, view: &str, account_id: &str) -> Result<Vec<Thread>, String> {
    let where_clause = match view {
        "inbox" => "in_inbox = 1 AND snoozed_until IS NULL",
        "reminders" => "snoozed_until IS NOT NULL",
        _ => "in_inbox = 0 AND snoozed_until IS NULL",
    };
    let sql = format!(
        "SELECT {THREAD_COLS} FROM threads WHERE {where_clause} AND account_id = ?1 ORDER BY last_date DESC LIMIT 500"
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![account_id], row_to_thread)
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();
    Ok(rows)
}

pub fn account_of_thread(conn: &Connection, id: &str) -> Option<String> {
    conn.query_row("SELECT account_id FROM threads WHERE id = ?1", params![id], |r| r.get(0))
        .ok()
}

pub fn get_thread(conn: &Connection, id: &str) -> Option<Thread> {
    let sql = format!("SELECT {THREAD_COLS} FROM threads WHERE id = ?1");
    conn.query_row(&sql, params![id], row_to_thread).ok()
}

pub fn get_messages(conn: &Connection, thread_id: &str) -> Result<Vec<Message>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, thread_id, from_addr, from_name, to_addrs, cc_addrs, subject, snippet,
                    body_text, body_html, date, unread
             FROM messages WHERE thread_id = ?1 ORDER BY date ASC",
        )
        .map_err(|e| e.to_string())?;
    let mut msgs: Vec<Message> = stmt
        .query_map(params![thread_id], |r| {
            Ok(Message {
                id: r.get(0)?,
                thread_id: r.get(1)?,
                from: r.get(2)?,
                from_name: r.get(3)?,
                to: serde_json::from_str(&r.get::<_, String>(4)?).unwrap_or_default(),
                cc: serde_json::from_str(&r.get::<_, String>(5)?).unwrap_or_default(),
                subject: r.get(6)?,
                snippet: r.get(7)?,
                body_text: r.get(8)?,
                body_html: r.get(9)?,
                date: r.get(10)?,
                unread: r.get::<_, i64>(11)? != 0,
                attachments: vec![],
            })
        })
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();

    for m in &mut msgs {
        let mut astmt = conn
            .prepare(
                "SELECT id, message_id, filename, mime_type, size_bytes
                 FROM attachments WHERE message_id = ?1",
            )
            .map_err(|e| e.to_string())?;
        m.attachments = astmt
            .query_map(params![m.id], |r| {
                Ok(Attachment {
                    id: r.get(0)?,
                    message_id: r.get(1)?,
                    filename: r.get(2)?,
                    mime_type: r.get(3)?,
                    size_bytes: r.get(4)?,
                })
            })
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();
    }
    Ok(msgs)
}

/// Upsert a thread and its messages (used by both mock seeding and Gmail sync).
pub fn upsert_thread(
    conn: &Connection,
    account_id: &str,
    t: &Thread,
    msgs: &[(Message, Option<String>, Vec<(Attachment, Option<String>, Option<String>)>)],
) -> Result<(), String> {
    conn.execute(
        "INSERT INTO threads (id, subject, snippet, participants, message_count, last_date,
                              unread, starred, labels, in_inbox, snoozed_until, account_id)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)
         ON CONFLICT(id) DO UPDATE SET
            subject=excluded.subject, snippet=excluded.snippet,
            participants=excluded.participants, message_count=excluded.message_count,
            last_date=excluded.last_date, unread=excluded.unread, starred=excluded.starred,
            labels=excluded.labels, in_inbox=excluded.in_inbox, account_id=excluded.account_id",
        params![
            t.id,
            t.subject,
            t.snippet,
            serde_json::to_string(&t.participants).unwrap(),
            t.message_count,
            t.last_date,
            t.unread as i64,
            t.starred as i64,
            serde_json::to_string(&t.labels).unwrap(),
            t.in_inbox as i64,
            t.snoozed_until,
            account_id,
        ],
    )
    .map_err(|e| e.to_string())?;

    for (m, rfc_id, atts) in msgs {
        let is_new = conn
            .query_row("SELECT 1 FROM messages WHERE id = ?1", params![m.id], |_| Ok(()))
            .is_err();
        conn.execute(
            "INSERT INTO messages (id, thread_id, from_addr, from_name, to_addrs, cc_addrs,
                                   subject, snippet, body_text, body_html, date, unread, rfc_message_id)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)
             ON CONFLICT(id) DO UPDATE SET unread=excluded.unread",
            params![
                m.id,
                m.thread_id,
                m.from,
                m.from_name,
                serde_json::to_string(&m.to).unwrap(),
                serde_json::to_string(&m.cc).unwrap(),
                m.subject,
                m.snippet,
                m.body_text,
                m.body_html,
                m.date,
                m.unread as i64,
                rfc_id,
            ],
        )
        .map_err(|e| e.to_string())?;

        if is_new {
            conn.execute(
                "INSERT INTO mail_fts (thread_id, subject, from_text, body) VALUES (?1,?2,?3,?4)",
                params![m.thread_id, m.subject, format!("{} {}", m.from_name, m.from), m.body_text],
            )
            .map_err(|e| e.to_string())?;
        }

        for (a, remote_id, text) in atts {
            conn.execute(
                "INSERT INTO attachments (id, message_id, filename, mime_type, size_bytes, remote_id, text_content)
                 VALUES (?1,?2,?3,?4,?5,?6,?7)
                 ON CONFLICT(id) DO NOTHING",
                params![a.id, a.message_id, a.filename, a.mime_type, a.size_bytes, remote_id, text],
            )
            .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

// ---------------------------------------------------------------- mutations

pub fn set_in_inbox(conn: &Connection, id: &str, in_inbox: bool) -> Result<(), String> {
    conn.execute(
        "UPDATE threads SET in_inbox = ?2, snoozed_until = NULL WHERE id = ?1",
        params![id, in_inbox as i64],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn set_snoozed(conn: &Connection, id: &str, until_ms: i64) -> Result<(), String> {
    conn.execute(
        "UPDATE threads SET snoozed_until = ?2, in_inbox = 0 WHERE id = ?1",
        params![id, until_ms],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Returns ids of threads whose snooze expired (they are moved back to inbox).
pub fn wake_due_snoozes(conn: &Connection, now_ms: i64) -> Result<Vec<String>, String> {
    let mut stmt = conn
        .prepare("SELECT id FROM threads WHERE snoozed_until IS NOT NULL AND snoozed_until <= ?1")
        .map_err(|e| e.to_string())?;
    let ids: Vec<String> = stmt
        .query_map(params![now_ms], |r| r.get(0))
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();
    for id in &ids {
        conn.execute(
            "UPDATE threads SET snoozed_until = NULL, in_inbox = 1, unread = 1 WHERE id = ?1",
            params![id],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(ids)
}

pub fn set_starred(conn: &Connection, id: &str, starred: bool) -> Result<(), String> {
    conn.execute("UPDATE threads SET starred = ?2 WHERE id = ?1", params![id, starred as i64])
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Trash = remove the thread from the local cache entirely (Gmail keeps it
/// recoverable server-side for 30 days).
pub fn delete_thread(conn: &Connection, id: &str) -> Result<(), String> {
    conn.execute("DELETE FROM mail_fts WHERE thread_id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    conn.execute(
        "DELETE FROM attachments WHERE message_id IN (SELECT id FROM messages WHERE thread_id = ?1)",
        params![id],
    )
    .map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM messages WHERE thread_id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM threads WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn clear_account_mail(conn: &Connection, account_id: &str) -> Result<(), String> {
    let mut stmt = conn
        .prepare("SELECT id FROM threads WHERE account_id = ?1")
        .map_err(|e| e.to_string())?;
    let ids: Vec<String> = stmt
        .query_map(params![account_id], |r| r.get(0))
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();
    drop(stmt);
    for id in ids {
        delete_thread(conn, &id)?;
    }
    Ok(())
}

pub fn set_unread(conn: &Connection, id: &str, unread: bool) -> Result<(), String> {
    conn.execute("UPDATE threads SET unread = ?2 WHERE id = ?1", params![id, unread as i64])
        .map_err(|e| e.to_string())?;
    if !unread {
        conn.execute("UPDATE messages SET unread = 0 WHERE thread_id = ?1", params![id])
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Toggle a label; returns true if the label is now present.
pub fn toggle_label(conn: &Connection, id: &str, label: &str) -> Result<bool, String> {
    let t = get_thread(conn, id).ok_or("unknown thread")?;
    let mut labels = t.labels;
    let added = if labels.iter().any(|l| l == label) {
        labels.retain(|l| l != label);
        false
    } else {
        labels.push(label.to_string());
        true
    };
    conn.execute(
        "UPDATE threads SET labels = ?2 WHERE id = ?1",
        params![id, serde_json::to_string(&labels).unwrap()],
    )
    .map_err(|e| e.to_string())?;
    Ok(added)
}

pub fn list_labels(conn: &Connection) -> Result<Vec<String>, String> {
    let mut set = std::collections::BTreeSet::new();
    set.insert("IMPORTANT".to_string());
    set.insert("STARRED".to_string());
    let mut stmt = conn.prepare("SELECT labels FROM threads").map_err(|e| e.to_string())?;
    let rows: Vec<String> = stmt
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();
    for raw in rows {
        if let Ok(labels) = serde_json::from_str::<Vec<String>>(&raw) {
            for l in labels {
                if !l.starts_with("CATEGORY_") && l != "INBOX" && l != "UNREAD" {
                    set.insert(l);
                }
            }
        }
    }
    Ok(set.into_iter().collect())
}

pub fn search(conn: &Connection, query: &str, account_id: &str) -> Result<Vec<SearchResult>, String> {
    if query.trim().is_empty() {
        return Ok(vec![]);
    }
    // FTS5 prefix query built from sanitized terms so raw user input can't
    // break the match-expression syntax.
    let terms: Vec<String> = query
        .split_whitespace()
        .map(|t| {
            let clean: String = t.chars().filter(|c| c.is_alphanumeric()).collect();
            format!("\"{clean}\"*")
        })
        .filter(|t| t.len() > 3)
        .collect();
    if terms.is_empty() {
        return Ok(vec![]);
    }
    let match_expr = terms.join(" ");
    let mut stmt = conn
        .prepare(
            "SELECT t.id, t.subject, t.snippet, t.last_date
             FROM mail_fts f JOIN threads t ON t.id = f.thread_id
             WHERE mail_fts MATCH ?1 AND t.account_id = ?2
             GROUP BY t.id ORDER BY t.last_date DESC LIMIT 60",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![match_expr, account_id], |r| {
            Ok(SearchResult {
                thread_id: r.get(0)?,
                subject: r.get(1)?,
                snippet: r.get(2)?,
                last_date: r.get(3)?,
            })
        })
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();
    Ok(rows)
}

/// Threads eligible for "Get Me To Zero"; the split filter runs in the caller
/// (split semantics live with the settings, not the store).
pub fn inbox_threads_for_sweep(conn: &Connection, account_id: &str) -> Result<Vec<Thread>, String> {
    list_threads(conn, "inbox", account_id)
}

