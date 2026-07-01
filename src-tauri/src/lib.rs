//! ZenBox Mail core: IPC surface, app state, and the background loop.
//! Every command validates its inputs; every secret stays in the keychain.
mod ai;
mod mail;
mod secrets;
mod store;
mod types;

use mail::gmail::GmailSession;
use rusqlite::Connection;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter, Manager, State};
use types::*;

pub struct AppState {
    db: Mutex<Connection>,
    http: reqwest::Client,
    gmail: tokio::sync::Mutex<Option<GmailSession>>,
    cancels: Mutex<HashMap<u64, Arc<AtomicBool>>>,
}

const BUNDLED_CELEBRATIONS: [&str; 4] = [
    "/inbox-zero/dawn-ridge.svg",
    "/inbox-zero/quiet-lake.svg",
    "/inbox-zero/night-dunes.svg",
    "/inbox-zero/aurora-field.svg",
];

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn is_mock_id(id: &str) -> bool {
    id.starts_with("t-")
}

fn valid_id(id: &str) -> Result<(), String> {
    if id.is_empty() || id.len() > 128 || !id.chars().all(|c| c.is_alphanumeric() || c == '-' || c == '_') {
        return Err("invalid id".into());
    }
    Ok(())
}

// ---------------------------------------------------------------- account

#[tauri::command]
fn get_account(state: State<'_, AppState>) -> AccountInfo {
    // boot breadcrumb: proves the webview⇄core IPC round-trip in dev logs
    #[cfg(debug_assertions)]
    eprintln!("[ipc] get_account");
    store::get_account(&state.db.lock().unwrap())
}

#[tauri::command]
async fn start_oauth(
    app: AppHandle,
    state: State<'_, AppState>,
    client_id: String,
    client_secret: String,
) -> Result<AccountInfo, String> {
    let client_id = client_id.trim().to_string();
    let client_secret = client_secret.trim().to_string();
    if client_id.is_empty() || client_secret.is_empty() {
        return Err("client ID and secret are both required".into());
    }
    secrets::set(secrets::GMAIL_CLIENT_ID, &client_id)?;
    secrets::set(secrets::GMAIL_CLIENT_SECRET, &client_secret)?;

    let outcome = mail::oauth::run_flow(&state.http, &app, &client_id, &client_secret).await?;
    secrets::set(secrets::GMAIL_REFRESH_TOKEN, &outcome.refresh_token)?;

    let email = GmailSession::profile_email(&state.http, &outcome.access_token).await?;
    let account = AccountInfo { email: email.clone(), provider: "gmail".into(), connected: true };
    {
        let conn = state.db.lock().unwrap();
        store::set_json(&conn, "account", &account)?;
        store::clear_mail(&conn)?; // drop demo data; real mail syncs in
    }
    let session = GmailSession::new_connected(email, outcome.access_token, outcome.expires_in)
        .ok_or("keychain readback failed")?;
    *state.gmail.lock().await = Some(session);
    sync_in_background(app);
    Ok(account)
}

#[tauri::command]
async fn disconnect_account(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    secrets::delete(secrets::GMAIL_REFRESH_TOKEN);
    secrets::delete(secrets::GMAIL_CLIENT_ID);
    secrets::delete(secrets::GMAIL_CLIENT_SECRET);
    *state.gmail.lock().await = None;
    {
        let conn = state.db.lock().unwrap();
        let account = AccountInfo {
            email: "demo@zenbox.local".into(),
            provider: "mock".into(),
            connected: true,
        };
        store::set_json(&conn, "account", &account)?;
        store::clear_mail(&conn)?;
        mail::mock::seed_if_empty(&conn)?;
    }
    let _ = app.emit("mail:updated", ());
    Ok(())
}

fn sync_in_background(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let state = app.state::<AppState>();
        let mut guard = state.gmail.lock().await;
        if let Some(session) = guard.as_mut() {
            match mail::sync::full_sync(&state.http, session, &state.db).await {
                Ok(true) => {
                    let _ = app.emit("mail:updated", ());
                }
                Ok(false) => {}
                Err(e) => eprintln!("[sync] {e}"),
            }
        }
    });
}

#[tauri::command]
async fn sync_now(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    {
        let conn = state.db.lock().unwrap();
        store::wake_due_snoozes(&conn, now_ms())?;
    }
    let mut guard = state.gmail.lock().await;
    if let Some(session) = guard.as_mut() {
        mail::sync::full_sync(&state.http, session, &state.db).await?;
    }
    let _ = app.emit("mail:updated", ());
    Ok(())
}

// ---------------------------------------------------------------- reading

#[tauri::command]
fn list_threads(state: State<'_, AppState>, view: String) -> Result<Vec<Thread>, String> {
    if !matches!(view.as_str(), "inbox" | "done" | "reminders") {
        return Err("invalid view".into());
    }
    store::list_threads(&state.db.lock().unwrap(), &view)
}

#[tauri::command]
async fn get_thread(state: State<'_, AppState>, thread_id: String) -> Result<Vec<Message>, String> {
    valid_id(&thread_id)?;
    let msgs = {
        let conn = state.db.lock().unwrap();
        let msgs = store::get_messages(&conn, &thread_id)?;
        store::set_unread(&conn, &thread_id, false)?;
        msgs
    };
    // mirror the read state to Gmail (best effort)
    if !is_mock_id(&thread_id) {
        let mut guard = state.gmail.lock().await;
        if let Some(s) = guard.as_mut() {
            let _ = s.modify_thread(&state.http, &thread_id, &[], &["UNREAD"]).await;
        }
    }
    Ok(msgs)
}

#[tauri::command]
fn search_threads(state: State<'_, AppState>, query: String) -> Result<Vec<SearchResult>, String> {
    if query.len() > 200 {
        return Err("query too long".into());
    }
    store::search(&state.db.lock().unwrap(), &query)
}

#[tauri::command]
fn list_labels(state: State<'_, AppState>) -> Result<Vec<String>, String> {
    store::list_labels(&state.db.lock().unwrap())
}

// ---------------------------------------------------------------- triage

async fn remote_modify(
    state: &State<'_, AppState>,
    thread_id: &str,
    add: &[&str],
    remove: &[&str],
) -> Result<(), String> {
    if is_mock_id(thread_id) {
        return Ok(());
    }
    let mut guard = state.gmail.lock().await;
    if let Some(s) = guard.as_mut() {
        s.modify_thread(&state.http, thread_id, add, remove).await?;
    }
    Ok(())
}

#[tauri::command]
async fn archive_thread(state: State<'_, AppState>, thread_id: String) -> Result<(), String> {
    valid_id(&thread_id)?;
    remote_modify(&state, &thread_id, &[], &["INBOX"]).await?;
    store::set_in_inbox(&state.db.lock().unwrap(), &thread_id, false)
}

#[tauri::command]
async fn move_to_inbox(state: State<'_, AppState>, thread_id: String) -> Result<(), String> {
    valid_id(&thread_id)?;
    remote_modify(&state, &thread_id, &["INBOX"], &[]).await?;
    store::set_in_inbox(&state.db.lock().unwrap(), &thread_id, true)
}

#[tauri::command]
async fn snooze_thread(
    state: State<'_, AppState>,
    thread_id: String,
    until_ms: i64,
) -> Result<(), String> {
    valid_id(&thread_id)?;
    if until_ms <= now_ms() {
        return Err("snooze time must be in the future".into());
    }
    remote_modify(&state, &thread_id, &[], &["INBOX"]).await?;
    store::set_snoozed(&state.db.lock().unwrap(), &thread_id, until_ms)
}

#[tauri::command]
async fn mark_unread(state: State<'_, AppState>, thread_id: String) -> Result<(), String> {
    valid_id(&thread_id)?;
    remote_modify(&state, &thread_id, &["UNREAD"], &[]).await?;
    store::set_unread(&state.db.lock().unwrap(), &thread_id, true)
}

#[tauri::command]
async fn move_label(
    state: State<'_, AppState>,
    thread_id: String,
    label: String,
) -> Result<(), String> {
    valid_id(&thread_id)?;
    if label.is_empty() || label.len() > 100 {
        return Err("invalid label".into());
    }
    let added = store::toggle_label(&state.db.lock().unwrap(), &thread_id, &label)?;
    if !is_mock_id(&thread_id) {
        let mut guard = state.gmail.lock().await;
        if let Some(s) = guard.as_mut() {
            let id = s.ensure_label_id(&state.http, &label).await?;
            if added {
                s.modify_thread(&state.http, &thread_id, &[id.as_str()], &[]).await?;
            } else {
                s.modify_thread(&state.http, &thread_id, &[], &[id.as_str()]).await?;
            }
        }
    }
    Ok(())
}

#[tauri::command]
async fn bulk_archive(
    app: AppHandle,
    state: State<'_, AppState>,
    opts: BulkArchiveOpts,
) -> Result<i64, String> {
    let (targets, settings) = {
        let conn = state.db.lock().unwrap();
        (store::inbox_threads_for_sweep(&conn)?, store::get_settings(&conn))
    };
    let cutoff = now_ms() - opts.older_than_days * 24 * 3_600_000;
    let mut n = 0i64;
    for t in targets {
        if opts.older_than_days > 0 && t.last_date > cutoff {
            continue;
        }
        if opts.preserve_unread && t.unread {
            continue;
        }
        if opts.preserve_starred && t.starred {
            continue;
        }
        if let Some(split_id) = &opts.split_id {
            if assign_split(&t, &settings.splits) != *split_id {
                continue;
            }
        }
        remote_modify(&state, &t.id, &[], &["INBOX"]).await?;
        store::set_in_inbox(&state.db.lock().unwrap(), &t.id, false)?;
        n += 1;
    }
    let _ = app.emit("mail:updated", ());
    Ok(n)
}

/// Port of assignSplit in src/lib/mock.ts — first matching split wins,
/// empty-rule splits are the catch-all.
fn assign_split(t: &Thread, splits: &[Split]) -> String {
    let mut catch_all: Option<&str> = None;
    for s in splits {
        if s.rules.is_empty() {
            catch_all.get_or_insert(&s.id);
            continue;
        }
        let mut results = s.rules.iter().map(|r| {
            let needle = r.contains.to_lowercase();
            if needle.is_empty() {
                return false;
            }
            match r.field.as_str() {
                "label" => t.labels.iter().any(|l| l.to_lowercase().contains(&needle)),
                "subject" => t.subject.to_lowercase().contains(&needle),
                _ => t.participants.iter().any(|p| p.to_lowercase().contains(&needle)),
            }
        });
        let matched = if s.op == "and" { results.all(|x| x) } else { results.any(|x| x) };
        if matched {
            return s.id.clone();
        }
    }
    catch_all.unwrap_or("other").to_string()
}

// ---------------------------------------------------------------- send

#[tauri::command]
async fn send_mail(
    app: AppHandle,
    state: State<'_, AppState>,
    mail: OutgoingMail,
) -> Result<(), String> {
    if mail.to.is_empty() {
        return Err("add at least one recipient".into());
    }
    for addr in mail.to.iter().chain(mail.cc.iter()) {
        if !addr.contains('@') || addr.len() > 254 || addr.contains(['\r', '\n']) {
            return Err(format!("\"{addr}\" is not a valid address"));
        }
    }
    let account = store::get_account(&state.db.lock().unwrap());

    if account.provider == "gmail" && !mail.thread_id.as_deref().map(is_mock_id).unwrap_or(false) {
        let in_reply_to: Option<String> = mail.thread_id.as_ref().and_then(|tid| {
            let conn = state.db.lock().unwrap();
            conn.query_row(
                "SELECT rfc_message_id FROM messages WHERE thread_id = ?1 AND rfc_message_id IS NOT NULL ORDER BY date DESC LIMIT 1",
                [tid.as_str()],
                |r| r.get::<_, Option<String>>(0),
            )
            .ok()
            .flatten()
        });
        let raw = mail::gmail::build_rfc822(&account.email, &mail, in_reply_to.as_deref());
        let mut guard = state.gmail.lock().await;
        let session = guard.as_mut().ok_or("Gmail session unavailable")?;
        session.send(&state.http, &raw, mail.thread_id.as_deref()).await?;
        drop(guard);
        sync_in_background(app);
        return Ok(());
    }

    // mock mode: append locally so the flow is fully demoable
    let conn = state.db.lock().unwrap();
    let now = now_ms();
    let (tid, subject) = match &mail.thread_id {
        Some(tid) => (tid.clone(), mail.subject.clone()),
        None => (format!("t-sent-{now}"), mail.subject.clone()),
    };
    let mid = format!("{tid}-m{now}");
    let msg = Message {
        id: mid,
        thread_id: tid.clone(),
        from: account.email.clone(),
        from_name: "You".into(),
        to: mail.to.clone(),
        cc: mail.cc.clone(),
        subject: subject.clone(),
        snippet: mail.body_text.chars().take(120).collect::<String>().replace('\n', " "),
        body_text: mail.body_text.clone(),
        body_html: None,
        date: now,
        unread: false,
        attachments: vec![],
    };
    let existing = store::get_thread(&conn, &tid);
    let thread = match existing {
        Some(mut t) => {
            t.message_count += 1;
            t.last_date = now;
            t.snippet = msg.snippet.clone();
            t
        }
        None => Thread {
            id: tid.clone(),
            subject: if subject.is_empty() { "(no subject)".into() } else { subject },
            snippet: msg.snippet.clone(),
            participants: vec![format!("You <{}>", account.email)],
            message_count: 1,
            last_date: now,
            unread: false,
            starred: false,
            labels: vec![],
            in_inbox: false,
            snoozed_until: None,
        },
    };
    store::upsert_thread(&conn, &thread, &[(msg, None, vec![])])?;
    drop(conn);
    let _ = app.emit("mail:updated", ());
    Ok(())
}

// ---------------------------------------------------------------- settings

#[tauri::command]
fn get_settings(state: State<'_, AppState>) -> Settings {
    store::get_settings(&state.db.lock().unwrap())
}

#[tauri::command]
fn save_settings(app: AppHandle, state: State<'_, AppState>, settings: Settings) -> Result<(), String> {
    if settings.splits.len() > 24 {
        return Err("too many splits".into());
    }
    if let Some(dir) = &settings.celebration_dir {
        let path = std::path::Path::new(dir);
        if path.is_dir() {
            let _ = app.asset_protocol_scope().allow_directory(path, false);
        }
    }
    store::set_json(&state.db.lock().unwrap(), "settings", &settings)
}

#[tauri::command]
fn get_knowledge_base(state: State<'_, AppState>) -> KnowledgeBase {
    store::get_kb(&state.db.lock().unwrap())
}

#[tauri::command]
fn save_knowledge_base(state: State<'_, AppState>, kb: KnowledgeBase) -> Result<(), String> {
    if kb.instructions.len() > 50_000 {
        return Err("instructions are too long".into());
    }
    store::set_json(&state.db.lock().unwrap(), "kb", &kb)
}

// ---------------------------------------------------------------- AI

#[tauri::command]
fn set_ai_key(state: State<'_, AppState>, provider: String, key: String) -> Result<(), String> {
    let entry = secrets::ai_key_entry(&provider).ok_or("unknown AI provider")?;
    let key = key.trim();
    if key.is_empty() {
        secrets::delete(entry);
    } else {
        if key.len() > 512 {
            return Err("that does not look like an API key".into());
        }
        secrets::set(entry, key)?;
    }
    // reflect hasKey in stored settings
    let conn = state.db.lock().unwrap();
    let mut settings = store::get_settings(&conn);
    for p in settings.providers.iter_mut() {
        if p.id == provider {
            p.has_key = !key.is_empty();
        }
    }
    store::set_json(&conn, "settings", &settings)
}

#[tauri::command]
async fn test_ai_provider(state: State<'_, AppState>, provider: String) -> Result<TestResult, String> {
    let settings = store::get_settings(&state.db.lock().unwrap());
    let resolved = match ai::resolve(&settings, Some(&provider)) {
        Ok(r) => r,
        Err(message) => return Ok(TestResult { ok: false, message }),
    };
    Ok(ai::test_provider(&state.http, &resolved).await)
}

#[tauri::command]
async fn ai_draft(
    state: State<'_, AppState>,
    req: DraftRequest,
    request_id: u64,
    on_chunk: Channel<String>,
) -> Result<(), String> {
    if req.instruction.trim().is_empty() {
        return Err("tell the AI what to write".into());
    }
    if req.instruction.len() > 8_000 {
        return Err("instruction is too long".into());
    }
    if let Some(tid) = &req.thread_id {
        valid_id(tid)?;
    }
    let settings = store::get_settings(&state.db.lock().unwrap());
    let resolved = ai::resolve(&settings, req.provider_id.as_deref())?;

    let cancel = Arc::new(AtomicBool::new(false));
    state.cancels.lock().unwrap().insert(request_id, cancel.clone());

    let ctx = ai::context::assemble(
        &state.db,
        &state.http,
        &state.gmail,
        &req,
        ai::supports_images(&resolved.id),
    )
    .await?;

    let result = ai::stream_draft(
        &state.http,
        &resolved,
        &ctx,
        |chunk| {
            let _ = on_chunk.send(chunk);
        },
        cancel,
    )
    .await;

    state.cancels.lock().unwrap().remove(&request_id);
    result
}

#[tauri::command]
fn cancel_ai(state: State<'_, AppState>, request_id: u64) {
    if let Some(flag) = state.cancels.lock().unwrap().get(&request_id) {
        flag.store(true, Ordering::Relaxed);
    }
}

#[tauri::command]
async fn ai_suggest_replies(
    state: State<'_, AppState>,
    thread_id: String,
) -> Result<Vec<String>, String> {
    valid_id(&thread_id)?;
    let settings = store::get_settings(&state.db.lock().unwrap());
    let resolved = ai::resolve(&settings, None)?; // errs (and hides UI) when no key
    let req = DraftRequest {
        thread_id: Some(thread_id),
        instruction: "Suggest up to 3 short, distinct replies the user might send to the latest message. \
                      Each under 30 words, in the user's voice per the instructions. \
                      Respond with ONLY a JSON array of strings — no other text."
            .into(),
        existing_text: None,
        provider_id: None,
    };
    let ctx = ai::context::assemble(&state.db, &state.http, &state.gmail, &req, false).await?;
    let raw = ai::complete(&state.http, &resolved, &ctx.system, &ctx.user_text).await?;
    Ok(ai::parse_suggestions(&raw))
}

// ---------------------------------------------------------------- inbox zero

#[tauri::command]
fn get_streaks(state: State<'_, AppState>) -> Streaks {
    store::get_streaks(&state.db.lock().unwrap())
}

fn celebration_pool(app: &AppHandle, settings: &Settings) -> Vec<String> {
    if let Some(dir) = &settings.celebration_dir {
        let path = std::path::Path::new(dir);
        if let Ok(entries) = std::fs::read_dir(path) {
            let imgs: Vec<String> = entries
                .filter_map(|e| e.ok())
                .map(|e| e.path())
                .filter(|p| {
                    matches!(
                        p.extension().and_then(|x| x.to_str()).map(|s| s.to_ascii_lowercase()).as_deref(),
                        Some("png" | "jpg" | "jpeg" | "webp" | "gif" | "svg")
                    )
                })
                .filter_map(|p| p.to_str().map(str::to_string))
                .collect();
            if !imgs.is_empty() {
                let _ = app.asset_protocol_scope().allow_directory(path, false);
                return imgs;
            }
        }
    }
    BUNDLED_CELEBRATIONS.iter().map(|s| s.to_string()).collect()
}

#[tauri::command]
fn record_zero(app: AppHandle, state: State<'_, AppState>, split_id: String) -> Result<Option<ZeroEvent>, String> {
    let conn = state.db.lock().unwrap();
    let mut s = store::get_streaks(&conn);
    let today = chrono::Local::now().format("%Y-%m-%d").to_string();
    if s.last_zero_day.as_deref() != Some(today.as_str()) {
        let yesterday = (chrono::Local::now() - chrono::Duration::days(1))
            .format("%Y-%m-%d")
            .to_string();
        s.daily = if s.last_zero_day.as_deref() == Some(yesterday.as_str()) { s.daily + 1 } else { 1 };
        s.weekly = s.daily / 7;
        s.last_zero_day = Some(today);
        store::set_json(&conn, "streaks", &s)?;
    }
    let settings = store::get_settings(&conn);
    drop(conn);
    let pool = celebration_pool(&app, &settings);
    let idx = (now_ms() as usize) % pool.len();
    Ok(Some(ZeroEvent {
        split_id,
        daily: s.daily,
        weekly: s.weekly,
        image_path: pool[idx].clone(),
    }))
}

#[tauri::command]
fn list_celebration_images(app: AppHandle, state: State<'_, AppState>) -> Vec<String> {
    let settings = store::get_settings(&state.db.lock().unwrap());
    celebration_pool(&app, &settings)
}

// ---------------------------------------------------------------- bootstrap

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            let conn = store::open(&data_dir.join("zenbox.db")).map_err(std::io::Error::other)?;

            let account = store::get_account(&conn);
            let gmail = if account.provider == "gmail" {
                GmailSession::from_keychain(account.email.clone())
            } else {
                mail::mock::seed_if_empty(&conn).map_err(std::io::Error::other)?;
                None
            };
            if account.provider == "gmail" && gmail.is_none() {
                // tokens were removed out-of-band: fall back to demo mode
                let _ = store::set_json(
                    &conn,
                    "account",
                    &AccountInfo { email: "demo@zenbox.local".into(), provider: "mock".into(), connected: true },
                );
                let _ = mail::mock::seed_if_empty(&conn);
            }

            // allow a previously-configured celebration folder
            let settings = store::get_settings(&conn);
            if let Some(dir) = &settings.celebration_dir {
                let p = std::path::Path::new(dir);
                if p.is_dir() {
                    let _ = app.asset_protocol_scope().allow_directory(p, false);
                }
            }

            let http = reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(120))
                .build()
                .expect("http client");

            app.manage(AppState {
                db: Mutex::new(conn),
                http,
                gmail: tokio::sync::Mutex::new(gmail),
                cancels: Mutex::new(HashMap::new()),
            });

            // background loop: snooze wake-ups every 30s, Gmail sync every 60s
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let mut tick: u64 = 0;
                loop {
                    tokio::time::sleep(std::time::Duration::from_secs(30)).await;
                    tick += 1;
                    let state = handle.state::<AppState>();
                    let woke: Vec<String> = {
                        let conn = state.db.lock().unwrap();
                        store::wake_due_snoozes(&conn, now_ms()).unwrap_or_default()
                    };
                    let mut changed = !woke.is_empty();
                    {
                        let mut guard = state.gmail.lock().await;
                        if let Some(session) = guard.as_mut() {
                            for id in &woke {
                                if !is_mock_id(id) {
                                    let _ = session
                                        .modify_thread(&state.http, id, &["INBOX", "UNREAD"], &[])
                                        .await;
                                }
                            }
                            if tick % 2 == 0 {
                                if let Ok(c) = mail::sync::full_sync(&state.http, session, &state.db).await {
                                    changed |= c;
                                }
                            }
                        }
                    }
                    if changed {
                        let _ = handle.emit("mail:updated", ());
                    }
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_account,
            start_oauth,
            disconnect_account,
            sync_now,
            list_threads,
            get_thread,
            search_threads,
            list_labels,
            archive_thread,
            move_to_inbox,
            snooze_thread,
            mark_unread,
            move_label,
            bulk_archive,
            send_mail,
            get_settings,
            save_settings,
            get_knowledge_base,
            save_knowledge_base,
            set_ai_key,
            test_ai_provider,
            ai_draft,
            cancel_ai,
            ai_suggest_replies,
            get_streaks,
            record_zero,
            list_celebration_images,
        ])
        .run(tauri::generate_context!())
        .expect("error while running ZenBox Mail");
}
