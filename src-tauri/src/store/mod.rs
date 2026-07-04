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
        "ALTER TABLE threads ADD COLUMN account_id TEXT NOT NULL DEFAULT 'demo@fission.local'",
        [],
    );
    // v0.3 migrations: soft trash/spam, unsubscribe header, scheduled sends.
    let _ = conn.execute("ALTER TABLE threads ADD COLUMN hidden TEXT", []);
    let _ = conn.execute("ALTER TABLE messages ADD COLUMN list_unsubscribe TEXT", []);
    // v0.5 migrations: inline-image cids + cached attachment bytes, drafts.
    let _ = conn.execute("ALTER TABLE attachments ADD COLUMN content_id TEXT", []);
    let _ = conn.execute("ALTER TABLE attachments ADD COLUMN data BLOB", []);
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS drafts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            account_id TEXT NOT NULL,
            payload TEXT NOT NULL,
            updated_at INTEGER NOT NULL
        );",
    )
    .map_err(|e| e.to_string())?;
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS outbox (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            account_id TEXT NOT NULL,
            payload TEXT NOT NULL,
            send_at INTEGER NOT NULL,
            attempts INTEGER NOT NULL DEFAULT 0
        );",
    )
    .map_err(|e| e.to_string())?;
    // v0.9: Gmail label id → display name, refreshed on reconcile so opaque
    // Label_… ids resolve to names on read.
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS labels (
            account_id TEXT NOT NULL,
            id TEXT NOT NULL,
            name TEXT NOT NULL,
            PRIMARY KEY (account_id, id)
        );",
    )
    .map_err(|e| e.to_string())?;
    // v0.9: local-first calendar — events cache read by the panel/week view,
    // refreshed in the background (mirrors the mail read/sync split).
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS events (
            account_id TEXT NOT NULL,
            id TEXT NOT NULL,
            calendar TEXT NOT NULL DEFAULT '',
            color TEXT,
            title TEXT NOT NULL DEFAULT '',
            start_ms INTEGER NOT NULL,
            end_ms INTEGER NOT NULL,
            all_day INTEGER NOT NULL DEFAULT 0,
            location TEXT,
            PRIMARY KEY (account_id, id)
        );
        CREATE INDEX IF NOT EXISTS idx_events_time ON events(account_id, start_ms);",
    )
    .map_err(|e| e.to_string())?;
    // v0.9: contact index for recipient autocomplete, derived from every
    // person the account has corresponded with (senders + recipients). freq
    // ranks how often they appear; last_seen breaks ties toward recency.
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS contacts (
            account_id TEXT NOT NULL,
            email TEXT NOT NULL,
            name TEXT NOT NULL DEFAULT '',
            freq INTEGER NOT NULL DEFAULT 0,
            last_seen INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (account_id, email)
        );
        CREATE INDEX IF NOT EXISTS idx_contacts_rank ON contacts(account_id, freq);",
    )
    .map_err(|e| e.to_string())?;
    // Backfill the index once from mail that synced before this version.
    // Idempotent + gated so it doesn't rescan on every launch.
    if get_json::<bool>(&conn, "contacts_built_v1") != Some(true) {
        backfill_contacts(&conn)?;
        let _ = set_json(&conn, "contacts_built_v1", &true);
    }
    Ok(conn)
}

pub const DEMO_ACCOUNT: &str = "demo@fission.local";
pub const DEMO_ACCOUNT_2: &str = "angel@fission.local";

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
        ("thread.trash", "#|delete|backspace"),
        ("thread.spam", "!"),
        ("thread.mute", "m"),
        ("thread.notDone", "shift+e"),
        ("thread.unsubscribe", "mod+u"),
        ("undo", "z|mod+z"),
        ("search", "/"),
        ("ai.ask", "?"),
        ("split.next", "tab"),
        ("split.prev", "shift+tab"),
        ("goto.inbox", "g i"),
        ("goto.other", "g o"),
        ("goto.done", "g e"),
        ("goto.reminders", "g h"),
        ("goto.starred", "g s"),
        ("goto.trash", "g t"),
        ("goto.drafts", "g d"),
        ("compose.ai", "mod+j"),
        ("compose.send", "mod+enter"),
        ("compose.sendDone", "mod+shift+enter"),
        ("compose.sendLater", "mod+shift+l"),
        ("compose.snippet", "mod+;"),
        ("theme.toggle", ""),
        ("calendar.toggle", ""),
        ("calendar.open", "g c"),
        ("calendar.prevDay", "left"),
        ("calendar.nextDay", "right"),
        ("calendar.today", ""),
        ("sidebar.toggle", ""),
        ("shortcutBar.toggle", ""),
        ("list.selectAll", "mod+a"),
        ("list.toggleSelect", "x"),
        ("thread.cycleSuggestion", "tab"),
        ("thread.scrollDown", "space"),
        ("back", "escape"),
        ("inbox.zeroSweep", ""),
        ("sync.now", ""),
        ("sync.resync", ""),
        ("update.check", ""),
        ("settings.open", "mod+,"),
        // Alt+N leaves Ctrl+N free for browser-muscle-memory shortcuts and
        // matches the user's preference (v0.6 change; mod+N was the default
        // through v0.5 — get_settings migrates saved copies).
        ("account.1", "alt+1"),
        ("account.2", "alt+2"),
        ("account.3", "alt+3"),
        ("account.4", "alt+4"),
        ("account.5", "alt+5"),
        ("account.6", "alt+6"),
        ("account.7", "alt+7"),
        ("account.8", "alt+8"),
        ("account.9", "alt+9"),
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
            // the builtin "Calendar" split became the side panel in v0.7;
            // get_settings drops saved copies on read
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
        theme: "dark".into(),
        notifications: true,
        onboarded: false,
        calendar_open: false,
        sidebar_open: false,
        show_shortcut_bar: true,
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
            // v0.6: account switching moved mod+N → alt+N. Migrate saved
            // copies that still hold the old default; custom remaps survive.
            for n in 1..=9 {
                let key = format!("account.{n}");
                if let Some(v) = s.shortcuts.get_mut(&key) {
                    if *v == format!("mod+{n}") {
                        *v = format!("alt+{n}");
                    }
                }
            }
            // v0.9: Delete/Backspace joined "#" as trash defaults. Upgrade
            // saved copies still on the old default; custom remaps survive.
            if let Some(v) = s.shortcuts.get_mut("thread.trash") {
                if v == "#" {
                    *v = "#|delete|backspace".into();
                }
            }
            for p in defaults.providers {
                if !s.providers.iter().any(|x| x.id == p.id) {
                    s.providers.push(p);
                }
            }
            // v0.7: the builtin Calendar split became the side panel
            s.splits.retain(|sp| !(sp.builtin && sp.id == "calendar"));
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
    // Every view except trash hides soft-deleted rows; trash IS those rows.
    let where_clause = match view {
        "inbox" => "in_inbox = 1 AND snoozed_until IS NULL AND hidden IS NULL",
        "reminders" => "snoozed_until IS NOT NULL AND hidden IS NULL",
        "starred" => "starred = 1 AND hidden IS NULL",
        "trash" => "hidden = 'trash'",
        _ => "in_inbox = 0 AND snoozed_until IS NULL AND hidden IS NULL",
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

/// Threads carrying a label, by display name (json_each is quote-safe where
/// a LIKE pattern is not).
pub fn list_threads_by_label(
    conn: &Connection,
    label: &str,
    account_id: &str,
) -> Result<Vec<Thread>, String> {
    let sql = format!(
        "SELECT {THREAD_COLS} FROM threads
         WHERE account_id = ?1 AND hidden IS NULL
           AND EXISTS (SELECT 1 FROM json_each(threads.labels) WHERE json_each.value = ?2)
         ORDER BY last_date DESC LIMIT 500"
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![account_id, label], row_to_thread)
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

/// One message row bound for upsert: (message, rfc Message-ID,
/// List-Unsubscribe header, attachments as (meta, remote id, Content-ID,
/// cached text)).
pub type MsgRow = (
    Message,
    Option<String>,
    Option<String>,
    Vec<(Attachment, Option<String>, Option<String>, Option<String>)>,
);

/// Upsert a thread and its messages (used by both mock seeding and Gmail sync).
pub fn upsert_thread(
    conn: &Connection,
    account_id: &str,
    t: &Thread,
    msgs: &[MsgRow],
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

    let mut any_healed = false;
    for (m, rfc_id, list_unsub, atts) in msgs {
        // The current body tells us (a) new vs. existing and (b) whether this
        // upsert heals a previously empty/frozen body — which the search index
        // must then be told about (its per-message insert only fires for new rows).
        let existing_body: Option<String> = conn
            .query_row("SELECT body_text FROM messages WHERE id = ?1", params![m.id], |r| r.get(0))
            .ok();
        let is_new = existing_body.is_none();
        conn.execute(
            "INSERT INTO messages (id, thread_id, from_addr, from_name, to_addrs, cc_addrs,
                                   subject, snippet, body_text, body_html, date, unread,
                                   rfc_message_id, list_unsubscribe)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)
             ON CONFLICT(id) DO UPDATE SET
                unread=excluded.unread,
                subject=excluded.subject,
                snippet=excluded.snippet,
                to_addrs=excluded.to_addrs,
                cc_addrs=excluded.cc_addrs,
                rfc_message_id=excluded.rfc_message_id,
                list_unsubscribe=excluded.list_unsubscribe,
                -- Gmail message bodies are immutable, so a non-empty re-parse is
                -- always the correct value. This heals rows an older build (or a
                -- first sync that couldn't fetch the HTML) froze with NULL/empty
                -- HTML — but never clobber a good cached body with an empty one.
                body_text=CASE WHEN excluded.body_text <> '' THEN excluded.body_text ELSE messages.body_text END,
                body_html=COALESCE(excluded.body_html, messages.body_html)",
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
                list_unsub,
            ],
        )
        .map_err(|e| e.to_string())?;

        if is_new {
            conn.execute(
                "INSERT INTO mail_fts (thread_id, subject, from_text, body) VALUES (?1,?2,?3,?4)",
                params![m.thread_id, m.subject, format!("{} {}", m.from_name, m.from), m.body_text],
            )
            .map_err(|e| e.to_string())?;
            // Index everyone on a first-seen message so freq counts distinct
            // messages (re-syncs of the same message never double-count).
            index_contact(conn, account_id, &m.from_name, &m.from, m.date);
            for addr in m.to.iter().chain(m.cc.iter()) {
                if let Some((name, email)) = parse_addr(addr) {
                    index_contact(conn, account_id, &name, &email, m.date);
                }
            }
        } else if existing_body.as_deref().map(str::trim).unwrap_or("").is_empty()
            && !m.body_text.trim().is_empty()
        {
            any_healed = true;
        }

        for (a, remote_id, content_id, text) in atts {
            conn.execute(
                "INSERT INTO attachments (id, message_id, filename, mime_type, size_bytes, remote_id, content_id, text_content)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8)
                 ON CONFLICT(id) DO NOTHING",
                params![a.id, a.message_id, a.filename, a.mime_type, a.size_bytes, remote_id, content_id, text],
            )
            .map_err(|e| e.to_string())?;
        }
    }

    // Rebuild this thread's FTS rows when a body healed, so recovered text is
    // searchable. `msgs` is the full thread on the sync/seed path.
    if any_healed {
        conn.execute("DELETE FROM mail_fts WHERE thread_id = ?1", params![t.id])
            .map_err(|e| e.to_string())?;
        for (m, _, _, _) in msgs {
            conn.execute(
                "INSERT INTO mail_fts (thread_id, subject, from_text, body) VALUES (?1,?2,?3,?4)",
                params![m.thread_id, m.subject, format!("{} {}", m.from_name, m.from), m.body_text],
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

/// Soft-hide (trash/spam). The row stays so undo can restore it instantly.
pub fn set_hidden(conn: &Connection, id: &str, reason: Option<&str>) -> Result<(), String> {
    match reason {
        Some(r) => conn.execute(
            "UPDATE threads SET hidden = ?2, in_inbox = 0, snoozed_until = NULL WHERE id = ?1",
            params![id, r],
        ),
        None => conn.execute(
            "UPDATE threads SET hidden = NULL, in_inbox = 1, snoozed_until = NULL WHERE id = ?1",
            params![id],
        ),
    }
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Sync-side unhide: clears the flag without forcing in_inbox back on —
/// the listing diff owns where a restored thread actually lives.
pub fn clear_hidden(conn: &Connection, id: &str) -> Result<(), String> {
    conn.execute("UPDATE threads SET hidden = NULL WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn hidden_reason(conn: &Connection, id: &str) -> Option<String> {
    conn.query_row("SELECT hidden FROM threads WHERE id = ?1", params![id], |r| {
        r.get::<_, Option<String>>(0)
    })
    .ok()
    .flatten()
}

/// Inbox threads carrying the Muted label — sync auto-archives these.
pub fn muted_inbox_threads(conn: &Connection, account_id: &str) -> Vec<String> {
    let Ok(mut stmt) = conn.prepare(
        "SELECT id FROM threads
         WHERE account_id = ?1 AND in_inbox = 1 AND hidden IS NULL AND labels LIKE '%\"Muted\"%'",
    ) else {
        return vec![];
    };
    stmt.query_map(params![account_id], |r| r.get(0))
        .map(|rows| rows.filter_map(|r| r.ok()).collect())
        .unwrap_or_default()
}

/// Most recent List-Unsubscribe header in a thread, if any message has one.
pub fn unsubscribe_header(conn: &Connection, thread_id: &str) -> Option<String> {
    conn.query_row(
        "SELECT list_unsubscribe FROM messages
         WHERE thread_id = ?1 AND list_unsubscribe IS NOT NULL
         ORDER BY date DESC LIMIT 1",
        params![thread_id],
        |r| r.get::<_, Option<String>>(0),
    )
    .ok()
    .flatten()
}

// ---------------------------------------------------------------- attachments

/// Everything needed to fetch/serve one attachment's bytes.
pub struct AttachmentRow {
    pub message_id: String,
    pub filename: String,
    pub mime_type: String,
    pub remote_id: Option<String>,
    pub data: Option<Vec<u8>>,
}

pub fn get_attachment(conn: &Connection, id: &str) -> Option<AttachmentRow> {
    conn.query_row(
        "SELECT message_id, filename, mime_type, remote_id, data FROM attachments WHERE id = ?1",
        params![id],
        |r| {
            Ok(AttachmentRow {
                message_id: r.get(0)?,
                filename: r.get(1)?,
                mime_type: r.get(2)?,
                remote_id: r.get(3)?,
                data: r.get(4)?,
            })
        },
    )
    .ok()
}

pub fn set_attachment_data(conn: &Connection, id: &str, data: &[u8]) -> Result<(), String> {
    conn.execute("UPDATE attachments SET data = ?2 WHERE id = ?1", params![id, data])
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Inline-image candidates for a message: (attachment id, Content-ID,
/// mime type, remote id, cached bytes present).
pub fn inline_cids(conn: &Connection, message_id: &str) -> Vec<(String, String, String, Option<String>, bool)> {
    let Ok(mut stmt) = conn.prepare(
        "SELECT id, content_id, mime_type, remote_id, data IS NOT NULL
         FROM attachments WHERE message_id = ?1 AND content_id IS NOT NULL",
    ) else {
        return vec![];
    };
    stmt.query_map(params![message_id], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, Option<String>>(3)?,
            r.get::<_, i64>(4)? != 0,
        ))
    })
    .map(|rows| rows.filter_map(|r| r.ok()).collect())
    .unwrap_or_default()
}

pub fn attachment_data(conn: &Connection, id: &str) -> Option<Vec<u8>> {
    conn.query_row("SELECT data FROM attachments WHERE id = ?1", params![id], |r| {
        r.get::<_, Option<Vec<u8>>>(0)
    })
    .ok()
    .flatten()
}

// ---------------------------------------------------------------- drafts

pub fn draft_save(
    conn: &Connection,
    id: Option<i64>,
    account_id: &str,
    payload: &str,
    now_ms: i64,
) -> Result<i64, String> {
    match id {
        Some(id) => {
            let n = conn
                .execute(
                    "UPDATE drafts SET payload = ?2, updated_at = ?3 WHERE id = ?1",
                    params![id, payload, now_ms],
                )
                .map_err(|e| e.to_string())?;
            if n > 0 {
                return Ok(id);
            }
            // row vanished (sent elsewhere) — recreate rather than lose work
            draft_save(conn, None, account_id, payload, now_ms)
        }
        None => {
            conn.execute(
                "INSERT INTO drafts (account_id, payload, updated_at) VALUES (?1, ?2, ?3)",
                params![account_id, payload, now_ms],
            )
            .map_err(|e| e.to_string())?;
            Ok(conn.last_insert_rowid())
        }
    }
}

pub fn draft_list(conn: &Connection, account_id: &str) -> Vec<(i64, String, i64)> {
    let Ok(mut stmt) = conn.prepare(
        "SELECT id, payload, updated_at FROM drafts WHERE account_id = ?1 ORDER BY updated_at DESC LIMIT 100",
    ) else {
        return vec![];
    };
    stmt.query_map(params![account_id], |r| {
        Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?, r.get::<_, i64>(2)?))
    })
    .map(|rows| rows.filter_map(|r| r.ok()).collect())
    .unwrap_or_default()
}

pub fn draft_delete(conn: &Connection, id: i64) {
    let _ = conn.execute("DELETE FROM drafts WHERE id = ?1", params![id]);
}

// ---------------------------------------------------------------- outbox

pub fn outbox_add(
    conn: &Connection,
    account_id: &str,
    mail: &OutgoingMail,
    send_at: i64,
) -> Result<i64, String> {
    conn.execute(
        "INSERT INTO outbox (account_id, payload, send_at) VALUES (?1, ?2, ?3)",
        params![account_id, serde_json::to_string(mail).map_err(|e| e.to_string())?, send_at],
    )
    .map_err(|e| e.to_string())?;
    Ok(conn.last_insert_rowid())
}

/// Remove a pending send and hand the draft back (None = already sent).
pub fn outbox_cancel(conn: &Connection, id: i64) -> Option<OutgoingMail> {
    let payload: Option<String> = conn
        .query_row("SELECT payload FROM outbox WHERE id = ?1", params![id], |r| r.get(0))
        .ok();
    let mail = payload.and_then(|p| serde_json::from_str(&p).ok())?;
    conn.execute("DELETE FROM outbox WHERE id = ?1", params![id]).ok()?;
    Some(mail)
}

pub fn outbox_due(conn: &Connection, now_ms: i64) -> Vec<(i64, String, OutgoingMail)> {
    let Ok(mut stmt) = conn.prepare(
        "SELECT id, account_id, payload FROM outbox WHERE send_at <= ?1 AND attempts < 5",
    ) else {
        return vec![];
    };
    stmt.query_map(params![now_ms], |r| {
        Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?))
    })
    .map(|rows| {
        rows.filter_map(|r| r.ok())
            .filter_map(|(id, acc, p)| serde_json::from_str(&p).ok().map(|m| (id, acc, m)))
            .collect()
    })
    .unwrap_or_default()
}

pub fn outbox_delete(conn: &Connection, id: i64) {
    let _ = conn.execute("DELETE FROM outbox WHERE id = ?1", params![id]);
}

pub fn outbox_bump_attempts(conn: &Connection, id: i64) {
    let _ = conn.execute("UPDATE outbox SET attempts = attempts + 1 WHERE id = ?1", params![id]);
    // rows that exhausted their retries are dropped so they can't loop forever
    let _ = conn.execute("DELETE FROM outbox WHERE attempts >= 5", []);
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

/// Clear the per-thread `history_id` for an account so the next reconcile
/// treats every listed thread as changed and refetches it — used by the resync
/// repair to re-parse and heal frozen message bodies without dropping local
/// state (snoozes, read/hidden flags survive).
pub fn reset_history(conn: &Connection, account_id: &str) -> Result<(), String> {
    conn.execute(
        "UPDATE threads SET history_id = NULL WHERE account_id = ?1",
        params![account_id],
    )
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

/// Refresh the persisted id→name label map for one account.
pub fn upsert_labels(
    conn: &Connection,
    account_id: &str,
    pairs: &[(String, String)],
) -> Result<(), String> {
    for (id, name) in pairs {
        conn.execute(
            "INSERT INTO labels(account_id, id, name) VALUES(?1, ?2, ?3)
             ON CONFLICT(account_id, id) DO UPDATE SET name = excluded.name",
            params![account_id, id, name],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// id → display name for one account's Gmail labels.
pub fn label_map(conn: &Connection, account_id: &str) -> HashMap<String, String> {
    let Ok(mut stmt) = conn.prepare("SELECT id, name FROM labels WHERE account_id = ?1") else {
        return HashMap::new();
    };
    stmt.query_map(params![account_id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
        .map(|rows| rows.filter_map(|r| r.ok()).collect())
        .unwrap_or_default()
}

/// One-time repair: rewrite opaque label ids already persisted in
/// threads.labels to their display names (older syncs stored ids verbatim).
pub fn rename_thread_labels(
    conn: &Connection,
    account_id: &str,
    map: &HashMap<String, String>,
) -> Result<bool, String> {
    if map.is_empty() {
        return Ok(false);
    }
    let mut stmt = conn
        .prepare("SELECT id, labels FROM threads WHERE account_id = ?1")
        .map_err(|e| e.to_string())?;
    let rows: Vec<(String, String)> = stmt
        .query_map(params![account_id], |r| Ok((r.get(0)?, r.get(1)?)))
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();
    let mut changed = false;
    for (id, raw) in rows {
        let Ok(labels) = serde_json::from_str::<Vec<String>>(&raw) else { continue };
        let renamed: Vec<String> =
            labels.iter().map(|l| map.get(l).unwrap_or(l).clone()).collect();
        if renamed != labels {
            let json = serde_json::to_string(&renamed).map_err(|e| e.to_string())?;
            conn.execute("UPDATE threads SET labels = ?2 WHERE id = ?1", params![id, json])
                .map_err(|e| e.to_string())?;
            changed = true;
        }
    }
    Ok(changed)
}

// ---------------------------------------------------------------- contacts

/// Parse a recipient header value into (name, email). Handles "Name <email>",
/// "<email>", and a bare address; returns None if there's no address.
fn parse_addr(raw: &str) -> Option<(String, String)> {
    let raw = raw.trim();
    if let Some(lt) = raw.rfind('<') {
        if let Some(rel_gt) = raw[lt..].find('>') {
            let email = raw[lt + 1..lt + rel_gt].trim().to_lowercase();
            if email.contains('@') {
                let name = raw[..lt].trim().trim_matches('"').trim().to_string();
                return Some((name, email));
            }
        }
    }
    if raw.contains('@') && !raw.contains(char::is_whitespace) {
        return Some((String::new(), raw.to_lowercase()));
    }
    None
}

/// Record one appearance of a contact: bump freq, keep the most recent
/// last_seen, and fill in a name if we didn't have one.
fn index_contact(conn: &Connection, account_id: &str, name: &str, email: &str, date: i64) {
    let email = email.trim().to_lowercase();
    if !email.contains('@') || email.len() > 254 {
        return;
    }
    let name = name.trim();
    let _ = conn.execute(
        "INSERT INTO contacts (account_id, email, name, freq, last_seen)
         VALUES (?1, ?2, ?3, 1, ?4)
         ON CONFLICT(account_id, email) DO UPDATE SET
            freq = freq + 1,
            last_seen = MAX(last_seen, excluded.last_seen),
            name = CASE WHEN excluded.name <> '' THEN excluded.name ELSE contacts.name END",
        params![account_id, email, name, date],
    );
}

/// One-time build of the contact index from mail synced before v0.9.
fn backfill_contacts(conn: &Connection) -> Result<(), String> {
    let mut stmt = conn
        .prepare(
            "SELECT t.account_id, m.from_name, m.from_addr, m.to_addrs, m.cc_addrs, m.date
             FROM messages m JOIN threads t ON t.id = m.thread_id",
        )
        .map_err(|e| e.to_string())?;
    let rows: Vec<(String, String, String, String, String, i64)> = stmt
        .query_map([], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?))
        })
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();
    for (account_id, from_name, from_addr, to_json, cc_json, date) in rows {
        index_contact(conn, &account_id, &from_name, &from_addr, date);
        for json in [&to_json, &cc_json] {
            if let Ok(addrs) = serde_json::from_str::<Vec<String>>(json) {
                for addr in addrs {
                    if let Some((name, email)) = parse_addr(&addr) {
                        index_contact(conn, &account_id, &name, &email, date);
                    }
                }
            }
        }
    }
    Ok(())
}

/// Ranked recipient suggestions for a typed query: prefix matches on name or
/// email first, then by how often the contact appears and how recently. The
/// account's own address is excluded (you don't autocomplete yourself).
pub fn search_contacts(
    conn: &Connection,
    account_id: &str,
    query: &str,
    limit: usize,
) -> Vec<Contact> {
    let q = query.trim().to_lowercase();
    if q.is_empty() {
        return vec![];
    }
    let esc = q.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_");
    let sub = format!("%{esc}%");
    let pre = format!("{esc}%");
    let Ok(mut stmt) = conn.prepare(
        "SELECT email, name FROM contacts
         WHERE account_id = ?1 AND email <> ?2
           AND (lower(name) LIKE ?3 ESCAPE '\\' OR email LIKE ?3 ESCAPE '\\')
         ORDER BY
           CASE WHEN lower(name) LIKE ?4 ESCAPE '\\' OR email LIKE ?4 ESCAPE '\\'
                THEN 0 ELSE 1 END,
           freq DESC, last_seen DESC
         LIMIT ?5",
    ) else {
        return vec![];
    };
    stmt.query_map(
        params![account_id, account_id.to_lowercase(), sub, pre, limit as i64],
        |r| Ok(Contact { email: r.get(0)?, name: r.get(1)? }),
    )
    .map(|rows| rows.filter_map(|r| r.ok()).collect())
    .unwrap_or_default()
}

/// Locally-trashed thread ids for one account (sync diffs these against the
/// server's in:trash listing).
pub fn trashed_thread_ids(conn: &Connection, account_id: &str) -> Vec<String> {
    let Ok(mut stmt) =
        conn.prepare("SELECT id FROM threads WHERE account_id = ?1 AND hidden = 'trash'")
    else {
        return vec![];
    };
    stmt.query_map(params![account_id], |r| r.get(0))
        .map(|rows| rows.filter_map(|r| r.ok()).collect())
        .unwrap_or_default()
}

// ---------------------------------------------------------------- calendar

/// Cached events overlapping [start_ms, end_ms), sorted by start.
pub fn list_events(
    conn: &Connection,
    account_id: &str,
    start_ms: i64,
    end_ms: i64,
) -> Vec<CalendarEvent> {
    let Ok(mut stmt) = conn.prepare(
        "SELECT id, calendar, color, title, start_ms, end_ms, all_day, location
         FROM events
         WHERE account_id = ?1 AND start_ms < ?3 AND end_ms > ?2
         ORDER BY start_ms",
    ) else {
        return vec![];
    };
    stmt.query_map(params![account_id, start_ms, end_ms], |r| {
        Ok(CalendarEvent {
            id: r.get(0)?,
            calendar: r.get(1)?,
            color: r.get(2)?,
            title: r.get(3)?,
            start_ms: r.get(4)?,
            end_ms: r.get(5)?,
            all_day: r.get::<_, i64>(6)? != 0,
            location: r.get(7)?,
        })
    })
    .map(|rows| rows.filter_map(|r| r.ok()).collect())
    .unwrap_or_default()
}

/// Replace the cached events for one fetched window: everything overlapping
/// the window is dropped, then the fresh listing is inserted.
pub fn replace_events(
    conn: &Connection,
    account_id: &str,
    window_start: i64,
    window_end: i64,
    events: &[CalendarEvent],
) -> Result<(), String> {
    conn.execute(
        "DELETE FROM events WHERE account_id = ?1 AND start_ms < ?3 AND end_ms > ?2",
        params![account_id, window_start, window_end],
    )
    .map_err(|e| e.to_string())?;
    for e in events {
        conn.execute(
            "INSERT OR REPLACE INTO events
                (account_id, id, calendar, color, title, start_ms, end_ms, all_day, location)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                account_id,
                e.id,
                e.calendar,
                e.color,
                e.title,
                e.start_ms,
                e.end_ms,
                e.all_day as i64,
                e.location
            ],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
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
             WHERE mail_fts MATCH ?1 AND t.account_id = ?2 AND t.hidden IS NULL
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

