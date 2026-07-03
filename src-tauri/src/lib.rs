//! Fission Mail core: IPC surface, app state, and the background loop.
//! Every command validates its inputs; every secret stays in the keychain.
mod ai;
mod mail;
mod secrets;
mod store;
mod types;
mod unsplash;

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
    /// One live session per connected Gmail account, keyed by email.
    gmail: tokio::sync::Mutex<HashMap<String, GmailSession>>,
    cancels: Mutex<HashMap<u64, Arc<AtomicBool>>>,
}

// A Google OAuth "Desktop app" client baked in at build time (CI secrets), so
// beta testers connect without creating their own client. Desktop clients
// cannot keep secrets by design — Google's model accepts an embedded id/secret
// for installed apps (PKCE still guards the flow). Keychain-pasted credentials
// always win over these.
// Prefer the FISSION_* build-time env; fall back to the legacy ZENBOX_* so the
// existing CI repo secret keeps working through the rename.
const BAKED_GMAIL_CLIENT_ID: Option<&str> = match option_env!("FISSION_GMAIL_CLIENT_ID") {
    Some(v) => Some(v),
    None => option_env!("ZENBOX_GMAIL_CLIENT_ID"),
};
const BAKED_GMAIL_CLIENT_SECRET: Option<&str> = match option_env!("FISSION_GMAIL_CLIENT_SECRET") {
    Some(v) => Some(v),
    None => option_env!("ZENBOX_GMAIL_CLIENT_SECRET"),
};

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
    id.starts_with("t-") || id.starts_with("t2-")
}

fn valid_id(id: &str) -> Result<(), String> {
    if id.is_empty() || id.len() > 128 || !id.chars().all(|c| c.is_alphanumeric() || c == '-' || c == '_') {
        return Err("invalid id".into());
    }
    Ok(())
}

// ---------------------------------------------------------------- accounts

#[tauri::command]
fn get_accounts(state: State<'_, AppState>) -> AccountsState {
    // boot breadcrumb: proves the webview⇄core IPC round-trip in dev logs
    #[cfg(debug_assertions)]
    eprintln!("[ipc] get_accounts");
    store::get_accounts(&state.db.lock().unwrap())
}

#[tauri::command]
fn switch_account(state: State<'_, AppState>, email: String) -> Result<AccountsState, String> {
    let conn = state.db.lock().unwrap();
    let mut accounts = store::get_accounts(&conn);
    if !accounts.accounts.iter().any(|a| a.email == email) {
        return Err("unknown account".into());
    }
    accounts.active = email;
    store::save_accounts(&conn, &accounts)?;
    Ok(accounts)
}

#[tauri::command]
fn reorder_accounts(state: State<'_, AppState>, emails: Vec<String>) -> Result<AccountsState, String> {
    let conn = state.db.lock().unwrap();
    let mut accounts = store::get_accounts(&conn);
    if emails.len() != accounts.accounts.len() {
        return Err("account list mismatch".into());
    }
    let mut reordered = vec![];
    for email in &emails {
        let a = accounts
            .accounts
            .iter()
            .find(|a| &a.email == email)
            .ok_or("unknown account in ordering")?;
        reordered.push(a.clone());
    }
    accounts.accounts = reordered;
    store::save_accounts(&conn, &accounts)?;
    Ok(accounts)
}

#[tauri::command]
fn has_gmail_client() -> bool {
    (secrets::get(secrets::GMAIL_CLIENT_ID).is_some()
        && secrets::get(secrets::GMAIL_CLIENT_SECRET).is_some())
        || (BAKED_GMAIL_CLIENT_ID.is_some() && BAKED_GMAIL_CLIENT_SECRET.is_some())
}

#[tauri::command]
async fn start_oauth(
    app: AppHandle,
    state: State<'_, AppState>,
    client_id: String,
    client_secret: String,
) -> Result<AccountsState, String> {
    // blank args = keychain client, else the build's baked-in beta client
    let client_id = if client_id.trim().is_empty() {
        secrets::get(secrets::GMAIL_CLIENT_ID)
            .or_else(|| BAKED_GMAIL_CLIENT_ID.map(str::to_string))
            .ok_or("no OAuth client available — paste the client ID and secret")?
    } else {
        client_id.trim().to_string()
    };
    let client_secret = if client_secret.trim().is_empty() {
        secrets::get(secrets::GMAIL_CLIENT_SECRET)
            .or_else(|| BAKED_GMAIL_CLIENT_SECRET.map(str::to_string))
            .ok_or("no OAuth client available — paste the client ID and secret")?
    } else {
        client_secret.trim().to_string()
    };
    secrets::set(secrets::GMAIL_CLIENT_ID, &client_id)?;
    secrets::set(secrets::GMAIL_CLIENT_SECRET, &client_secret)?;

    let outcome = mail::oauth::run_flow(&state.http, &app, &client_id, &client_secret).await?;
    // Non-fatal: warn if Gmail connected but Google skipped calendar.readonly, so
    // the user fixes it now instead of hitting a scope 403 in the calendar panel.
    let calendar_missing = outcome
        .granted_scope
        .as_deref()
        .map(|scope| !scope.contains("calendar.readonly"))
        .unwrap_or(false);
    let email = GmailSession::profile_email(&state.http, &outcome.access_token).await?;
    secrets::set(&secrets::gmail_refresh_entry(&email), &outcome.refresh_token)?;

    // Grab the display name + photo while we hold a fresh access token.
    if let Some(prof) = fetch_google_profile(&state.http, &outcome.access_token).await {
        let conn = state.db.lock().unwrap();
        let _ = store::set_json(&conn, &format!("profile:{email}"), &prof);
    }

    let accounts = {
        let conn = state.db.lock().unwrap();
        let mut accounts = store::get_accounts(&conn);
        // first real account replaces the demo pair (and their fixture mail)
        if accounts.accounts.iter().all(|a| a.provider == "mock") {
            for a in &accounts.accounts {
                store::clear_account_mail(&conn, &a.email)?;
            }
            accounts.accounts.clear();
        }
        if !accounts.accounts.iter().any(|a| a.email == email) {
            accounts.accounts.push(AccountInfo {
                email: email.clone(),
                provider: "gmail".into(),
                connected: true,
            });
        }
        accounts.active = email.clone();
        store::save_accounts(&conn, &accounts)?;
        accounts
    };

    let session = GmailSession::new_connected(email.clone(), outcome.access_token, outcome.expires_in)
        .ok_or("keychain readback failed")?;
    state.gmail.lock().await.insert(email, session);
    if calendar_missing {
        let _ = app.emit(
            "app:notice",
            "Connected, but Calendar access wasn't granted — run Connect Gmail again and check the Calendar box.".to_string(),
        );
    }
    sync_in_background(app);
    Ok(accounts)
}

#[tauri::command]
async fn disconnect_account(
    app: AppHandle,
    state: State<'_, AppState>,
    email: String,
) -> Result<AccountsState, String> {
    // Revoke server-side BEFORE deleting the local token, so the next Connect
    // starts from a clean grant and reliably re-issues the full scope set
    // (incl. calendar.readonly). Best-effort — a failed revoke still disconnects.
    if let Some(rt) = secrets::get(&secrets::gmail_refresh_entry(&email))
        .or_else(|| secrets::get(secrets::GMAIL_REFRESH_TOKEN_LEGACY))
    {
        let _ = state
            .http
            .post("https://oauth2.googleapis.com/revoke")
            .form(&[("token", rt.as_str())])
            .send()
            .await;
    }
    secrets::delete(&secrets::gmail_refresh_entry(&email));
    secrets::delete(secrets::GMAIL_REFRESH_TOKEN_LEGACY);
    state.gmail.lock().await.remove(&email);
    let accounts = {
        let conn = state.db.lock().unwrap();
        store::clear_account_mail(&conn, &email)?;
        let mut accounts = store::get_accounts(&conn);
        accounts.accounts.retain(|a| a.email != email);
        if accounts.accounts.is_empty() {
            // back to demo mode
            store::set_json(&conn, "accounts", &serde_json::Value::Null).ok();
            conn.execute("DELETE FROM kv WHERE key = 'accounts'", []).ok();
            let accounts = store::get_accounts(&conn);
            mail::mock::seed_if_empty(&conn)?;
            accounts
        } else {
            if accounts.active == email {
                accounts.active = accounts.accounts[0].email.clone();
            }
            store::save_accounts(&conn, &accounts)?;
            accounts
        }
    };
    let _ = app.emit("mail:updated", ());
    Ok(accounts)
}

/// OpenID userinfo → name + photo (photo inlined as a data: URI so the UI
/// renders it with zero network access).
async fn fetch_google_profile(http: &reqwest::Client, access_token: &str) -> Option<ProfileInfo> {
    let v: serde_json::Value = http
        .get("https://openidconnect.googleapis.com/v1/userinfo")
        .bearer_auth(access_token)
        .send()
        .await
        .ok()?
        .json()
        .await
        .ok()?;
    let name = v["name"].as_str().unwrap_or_default().to_string();
    let mut picture = None;
    if let Some(url) = v["picture"].as_str() {
        if let Ok(resp) = http.get(url).send().await {
            let mime = resp
                .headers()
                .get("content-type")
                .and_then(|h| h.to_str().ok())
                .unwrap_or("image/jpeg")
                .to_string();
            if let Ok(bytes) = resp.bytes().await {
                if bytes.len() <= 1_000_000 {
                    use base64::Engine;
                    picture = Some(format!(
                        "data:{mime};base64,{}",
                        base64::engine::general_purpose::STANDARD.encode(&bytes)
                    ));
                }
            }
        }
    }
    Some(ProfileInfo { name, picture })
}

const DAY_MS: i64 = 24 * 3_600_000;

/// Calendar events for the side panel / week view. Local-first: gmail
/// accounts read the SQLite cache (refresh_calendar repopulates it in the
/// background); demo accounts get fixture events so the panel is demoable
/// with zero credentials.
#[tauri::command]
fn list_events(
    state: State<'_, AppState>,
    start_ms: i64,
    end_ms: i64,
) -> Result<Vec<CalendarEvent>, String> {
    if end_ms <= start_ms || end_ms - start_ms > 62 * DAY_MS {
        return Err("invalid time range".into());
    }
    let conn = state.db.lock().unwrap();
    let active = store::active_account(&conn);
    if active.provider != "gmail" {
        return Ok(mail::mock::demo_events(start_ms, end_ms));
    }
    Ok(store::list_events(&conn, &active.email, start_ms, end_ms))
}

/// Fire-and-forget background refresh of one account's cached events for a
/// window. On completion (or failure) emits `calendar:updated` with an
/// optional error message so open panels repaint / surface guidance.
fn spawn_calendar_refresh(app: AppHandle, email: String, start_ms: i64, end_ms: i64) {
    tauri::async_runtime::spawn(async move {
        let state = app.state::<AppState>();
        let result = {
            let mut sessions = state.gmail.lock().await;
            let Some(session) = sessions.get_mut(&email) else { return };
            mail::calendar::list_events(&state.http, session, start_ms, end_ms).await
        };
        match result {
            Ok(events) => {
                {
                    let conn = state.db.lock().unwrap();
                    let _ = store::replace_events(&conn, &email, start_ms, end_ms, &events);
                    let _ = store::set_json(
                        &conn,
                        &format!("cal_window:{email}"),
                        &serde_json::json!({ "start": start_ms, "end": end_ms, "at": now_ms() }),
                    );
                }
                let _ = app.emit("calendar:updated", Option::<String>::None);
            }
            Err(e) => {
                let _ = app.emit("calendar:updated", Some(e));
            }
        }
    });
}

/// Ask for fresh events around a range. Throttled: if the last fetch already
/// covers the range and is under two minutes old, the cache stands.
#[tauri::command]
fn refresh_calendar(
    app: AppHandle,
    state: State<'_, AppState>,
    start_ms: i64,
    end_ms: i64,
) -> Result<(), String> {
    if end_ms <= start_ms || end_ms - start_ms > 62 * DAY_MS {
        return Err("invalid time range".into());
    }
    let active = {
        let conn = state.db.lock().unwrap();
        store::active_account(&conn)
    };
    if active.provider != "gmail" {
        return Ok(()); // demo events are synthesized on read
    }
    // widen the fetch so day-by-day navigation stays inside one cached window
    let fetch_start = start_ms - 3 * DAY_MS;
    let fetch_end = end_ms.max(start_ms + 11 * DAY_MS);
    {
        let conn = state.db.lock().unwrap();
        if let Some(w) =
            store::get_json::<serde_json::Value>(&conn, &format!("cal_window:{}", active.email))
        {
            let covered = w["start"].as_i64().unwrap_or(i64::MAX) <= start_ms
                && w["end"].as_i64().unwrap_or(0) >= end_ms;
            let fresh = now_ms() - w["at"].as_i64().unwrap_or(0) < 120_000;
            if covered && fresh {
                return Ok(());
            }
        }
    }
    spawn_calendar_refresh(app, active.email, fetch_start, fetch_end);
    Ok(())
}

/// The daily Unsplash photo for empty rest states: cached 24h, stale-if-error,
/// hard-capped at 50 API requests/hour locally.
#[tauri::command]
async fn get_daily_photo(state: State<'_, AppState>) -> Result<Option<DailyPhoto>, String> {
    let (cached, key) = {
        let conn = state.db.lock().unwrap();
        (
            store::get_json::<unsplash::CachedPhoto>(&conn, unsplash::KV_PHOTO),
            unsplash::access_key(),
        )
    };
    if let Some(c) = &cached {
        if now_ms() - c.photo.fetched_at < unsplash::DAY_MS {
            return Ok(Some(c.photo.clone()));
        }
    }
    let Some(key) = key else {
        return Ok(cached.map(|c| c.photo));
    };
    {
        let conn = state.db.lock().unwrap();
        if !unsplash::take_rate_token(&conn, now_ms()) {
            return Ok(cached.map(|c| c.photo));
        }
    }
    match unsplash::fetch_daily(&state.http, &key, now_ms()).await {
        Ok(photo) => {
            let conn = state.db.lock().unwrap();
            let _ = store::set_json(
                &conn,
                unsplash::KV_PHOTO,
                &unsplash::CachedPhoto { photo: photo.clone(), download_triggered: false },
            );
            Ok(Some(photo))
        }
        Err(e) => {
            // stale-if-error: yesterday's photo beats an error in a rest state
            eprintln!("[unsplash] fetch failed: {e}");
            Ok(cached.map(|c| c.photo))
        }
    }
}

/// Unsplash guideline: GET links.download_location the first time a photo is
/// actually shown. Fires once per cached photo.
#[tauri::command]
async fn photo_shown(state: State<'_, AppState>) -> Result<(), String> {
    let (cached, key) = {
        let conn = state.db.lock().unwrap();
        (
            store::get_json::<unsplash::CachedPhoto>(&conn, unsplash::KV_PHOTO),
            unsplash::access_key(),
        )
    };
    let Some(mut c) = cached else { return Ok(()) };
    if c.download_triggered {
        return Ok(());
    }
    let (Some(loc), Some(key)) = (c.photo.download_location.clone(), key) else {
        return Ok(());
    };
    c.download_triggered = true;
    {
        let conn = state.db.lock().unwrap();
        let _ = store::set_json(&conn, unsplash::KV_PHOTO, &c);
    }
    let _ = state
        .http
        .get(&loc)
        .header("Authorization", format!("Client-ID {key}"))
        .header("Accept-Version", "v1")
        .send()
        .await;
    Ok(())
}

/// BYO Unsplash Access Key: stored in the OS keychain, overrides the baked
/// key; an empty string clears it.
#[tauri::command]
fn set_unsplash_key(key: String) -> Result<(), String> {
    let k = key.trim();
    if k.is_empty() {
        secrets::delete(secrets::UNSPLASH_ACCESS_KEY);
        return Ok(());
    }
    if k.len() > 200 {
        return Err("that does not look like an Unsplash Access Key".into());
    }
    secrets::set(secrets::UNSPLASH_ACCESS_KEY, k)
}

#[tauri::command]
fn get_profile(state: State<'_, AppState>, email: String) -> Option<ProfileInfo> {
    store::get_json(&state.db.lock().unwrap(), &format!("profile:{email}"))
}

/// Override (or clear) the header photo. Accepts a data: URI.
#[tauri::command]
fn set_profile_photo(
    state: State<'_, AppState>,
    email: String,
    picture: Option<String>,
) -> Result<(), String> {
    if let Some(p) = &picture {
        if !p.starts_with("data:image/") || p.len() > 2_000_000 {
            return Err("that does not look like a reasonable image".into());
        }
    }
    let conn = state.db.lock().unwrap();
    let key = format!("profile:{email}");
    let mut prof: ProfileInfo = store::get_json(&conn, &key).unwrap_or_default();
    prof.picture = picture;
    store::set_json(&conn, &key, &prof)
}

/// New-mail notifications: anything unread that landed in an inbox after the
/// watermark. Skipped while the window is focused or when disabled.
fn notify_new_mail(app: &AppHandle, since_ms: i64) {
    let state = app.state::<AppState>();
    let (enabled, rows) = {
        let conn = state.db.lock().unwrap();
        let settings = store::get_settings(&conn);
        let rows: Vec<(String, String)> = conn
            .prepare(
                "SELECT participants, subject FROM threads
                 WHERE unread = 1 AND in_inbox = 1 AND hidden IS NULL AND last_date > ?1
                 ORDER BY last_date DESC LIMIT 4",
            )
            .and_then(|mut st| {
                st.query_map([since_ms], |r| Ok((r.get(0)?, r.get(1)?)))
                    .map(|it| it.filter_map(|r| r.ok()).collect())
            })
            .unwrap_or_default();
        (settings.notifications, rows)
    };
    if !enabled || rows.is_empty() {
        return;
    }
    let focused = app
        .get_webview_window("main")
        .map(|w| w.is_focused().unwrap_or(false))
        .unwrap_or(false);
    if focused {
        return;
    }
    use tauri_plugin_notification::NotificationExt;
    for (participants, subject) in rows.iter().take(3) {
        let sender = serde_json::from_str::<Vec<String>>(participants)
            .ok()
            .and_then(|p| p.last().cloned())
            .unwrap_or_default();
        let sender = sender.split('<').next().unwrap_or("New mail").trim().to_string();
        let _ = app
            .notification()
            .builder()
            .title(if sender.is_empty() { "New mail" } else { &sender })
            .body(subject)
            .show();
    }
    if rows.len() > 3 {
        let _ = app
            .notification()
            .builder()
            .title("Fission Mail")
            .body("…and more new mail")
            .show();
    }
}

fn sync_in_background(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let state = app.state::<AppState>();
        let mut changed = false;
        let mut sessions = state.gmail.lock().await;
        for (email, session) in sessions.iter_mut() {
            match mail::sync::full_sync(&state.http, session, &state.db, email, false).await {
                Ok(c) => changed |= c,
                Err(e) => eprintln!("[sync:{email}] {e}"),
            }
        }
        drop(sessions);
        if changed {
            let _ = app.emit("mail:updated", ());
        }
    });
}

#[tauri::command]
async fn sync_now(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    {
        let conn = state.db.lock().unwrap();
        store::wake_due_snoozes(&conn, now_ms())?;
    }
    let mut sessions = state.gmail.lock().await;
    for (email, session) in sessions.iter_mut() {
        mail::sync::full_sync(&state.http, session, &state.db, email, false).await?;
    }
    drop(sessions);
    let _ = app.emit("mail:updated", ());
    Ok(())
}

/// Repair: forget the incremental baseline and per-thread historyIds, then
/// resync — the reconcile pass then refetches and re-parses every listed thread,
/// healing messages an older build froze with missing HTML / empty bodies.
/// Local-only state (snoozes, read/hidden flags) is preserved.
#[tauri::command]
async fn resync_account(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    let emails: Vec<String> = state.gmail.lock().await.keys().cloned().collect();
    if emails.is_empty() {
        return Ok(()); // demo mode: nothing to resync
    }
    {
        let conn = state.db.lock().unwrap();
        for email in &emails {
            conn.execute("DELETE FROM kv WHERE key = ?1", [format!("history:{email}")]).ok();
            store::reset_history(&conn, email)?;
        }
    }
    let mut sessions = state.gmail.lock().await;
    for (email, session) in sessions.iter_mut() {
        // force a full reconcile — every thread re-parsed, bodies healed
        mail::sync::full_sync(&state.http, session, &state.db, email, true).await?;
    }
    drop(sessions);
    let _ = app.emit("mail:updated", ());
    Ok(())
}

// ---------------------------------------------------------------- reading

#[tauri::command]
fn list_threads(state: State<'_, AppState>, view: String) -> Result<Vec<Thread>, String> {
    // "label:<name>" scopes the list to one label; everything else is a
    // fixed view.
    if let Some(label) = view.strip_prefix("label:") {
        if label.is_empty() || label.len() > 100 {
            return Err("invalid label".into());
        }
        let conn = state.db.lock().unwrap();
        let active = store::get_accounts(&conn).active;
        return store::list_threads_by_label(&conn, label, &active);
    }
    if !matches!(view.as_str(), "inbox" | "done" | "reminders" | "starred" | "trash") {
        return Err("invalid view".into());
    }
    let conn = state.db.lock().unwrap();
    let active = store::get_accounts(&conn).active;
    store::list_threads(&conn, &view, &active)
}

#[tauri::command]
async fn get_thread(
    app: AppHandle,
    state: State<'_, AppState>,
    thread_id: String,
) -> Result<Vec<Message>, String> {
    valid_id(&thread_id)?;
    let (mut msgs, account) = {
        let conn = state.db.lock().unwrap();
        let msgs = store::get_messages(&conn, &thread_id)?;
        store::set_unread(&conn, &thread_id, false)?;
        (msgs, store::account_of_thread(&conn, &thread_id))
    };

    // First paint is instant: sanitize using ONLY inline images already cached
    // locally (no network). Raw bodies never reach the UI. The Gmail UNREAD
    // removal and any un-cached inline-image fetches run in the background
    // (spawn_thread_backfill), which re-emits so images fill in progressively.
    for m in msgs.iter_mut() {
        let Some(html) = m.body_html.clone() else { continue };
        let cid_map = cached_cid_map(&state, &m.id, &html);
        m.body_html = Some(mail::render::sanitize_email_html(&html, &cid_map));
    }
    spawn_thread_backfill(app, thread_id, account);
    Ok(msgs)
}

/// Build the cid→data: map for a message body from ALREADY-CACHED inline-image
/// bytes only — no network, so the first paint of a thread is instant.
fn cached_cid_map(state: &State<'_, AppState>, message_id: &str, html: &str) -> HashMap<String, String> {
    use base64::Engine;
    let mut cid_map = HashMap::new();
    let inline = {
        let conn = state.db.lock().unwrap();
        store::inline_cids(&conn, message_id)
    };
    for (att_id, content_id, mime, _remote, has_data) in inline {
        if !has_data || !html.contains(&format!("cid:{content_id}")) {
            continue;
        }
        let bytes = {
            let conn = state.db.lock().unwrap();
            store::attachment_data(&conn, &att_id)
        };
        if let Some(bytes) = bytes {
            let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
            cid_map.insert(content_id, format!("data:{mime};base64,{b64}"));
        }
    }
    cid_map
}

/// Background work for an opened thread: drop Gmail's UNREAD label and fetch any
/// inline `cid:` images not yet cached (persisting them), then emit `thread:images`
/// so the reading pane re-reads with images resolved. Keeps opening a thread from
/// blocking on a Gmail round-trip or the sync-held gmail mutex.
fn spawn_thread_backfill(app: AppHandle, thread_id: String, account: Option<String>) {
    if is_mock_id(&thread_id) {
        return;
    }
    let Some(account) = account else { return };
    tauri::async_runtime::spawn(async move {
        let state = app.state::<AppState>();
        // 1. clear UNREAD on the server (best-effort; local already cleared)
        {
            let mut sessions = state.gmail.lock().await;
            if let Some(s) = sessions.get_mut(&account) {
                let _ = s.modify_thread(&state.http, &thread_id, &[], &["UNREAD"]).await;
            }
        }
        // 2. fetch inline images still missing their bytes
        let msgs = {
            let conn = state.db.lock().unwrap();
            store::get_messages(&conn, &thread_id).unwrap_or_default()
        };
        let mut fetched_any = false;
        for m in &msgs {
            let Some(html) = &m.body_html else { continue };
            let inline = {
                let conn = state.db.lock().unwrap();
                store::inline_cids(&conn, &m.id)
            };
            for (att_id, content_id, _mime, remote_id, has_data) in inline {
                if has_data || !html.contains(&format!("cid:{content_id}")) {
                    continue;
                }
                let Some(remote) = remote_id else { continue };
                let bytes = {
                    let mut sessions = state.gmail.lock().await;
                    match sessions.get_mut(&account) {
                        Some(s) => s.get_attachment_bytes(&state.http, &m.id, &remote).await,
                        None => Err("no session".to_string()),
                    }
                };
                if let Ok(b) = bytes {
                    if b.len() <= 2_000_000 {
                        let conn = state.db.lock().unwrap();
                        let _ = store::set_attachment_data(&conn, &att_id, &b);
                        fetched_any = true;
                    }
                }
            }
        }
        if fetched_any {
            let _ = app.emit("thread:images", thread_id);
        }
    });
}

/// Heal messages persisted with an empty body (body_text='' AND body_html IS
/// NULL) — e.g. a large HTML body that lived behind body.attachmentId on first
/// sync, or a row an older build froze. Refetches the thread (hydrating
/// attachment-hosted bodies) so upsert re-parses and fills it, then returns the
/// freshly sanitized messages. No network for mock threads or when nothing is
/// blank. The frontend calls this only when it sees a blank card, and applies
/// the result only if the user is still on the thread. (BUG 5 empty-body)
#[tauri::command]
async fn refetch_message_body(
    state: State<'_, AppState>,
    thread_id: String,
) -> Result<Vec<Message>, String> {
    valid_id(&thread_id)?;
    let (has_empty, account) = {
        let conn = state.db.lock().unwrap();
        let has_empty: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM messages WHERE thread_id = ?1 AND body_text = '' AND body_html IS NULL)",
                [thread_id.as_str()],
                |r| r.get::<_, i64>(0),
            )
            .map(|n| n != 0)
            .unwrap_or(false);
        (has_empty, store::account_of_thread(&conn, &thread_id))
    };
    if has_empty && !is_mock_id(&thread_id) {
        if let Some(account) = account {
            let mut sessions = state.gmail.lock().await;
            if let Some(sess) = sessions.get_mut(&account) {
                let _ = mail::sync::refetch_thread(&state.http, sess, &state.db, &account, &thread_id).await;
            }
        }
    }
    let mut msgs = {
        let conn = state.db.lock().unwrap();
        store::get_messages(&conn, &thread_id)?
    };
    for m in msgs.iter_mut() {
        let Some(html) = m.body_html.clone() else { continue };
        let cid_map = cached_cid_map(&state, &m.id, &html);
        m.body_html = Some(mail::render::sanitize_email_html(&html, &cid_map));
    }
    Ok(msgs)
}

// ---------------------------------------------------------------- attachments

/// Attachment bytes from cache, demo fixture text, or Gmail (cached after).
async fn attachment_bytes(
    state: &State<'_, AppState>,
    attachment_id: &str,
) -> Result<(store::AttachmentRow, Vec<u8>), String> {
    let row = {
        let conn = state.db.lock().unwrap();
        store::get_attachment(&conn, attachment_id).ok_or("unknown attachment")?
    };
    if let Some(data) = row.data.clone() {
        return Ok((row, data));
    }
    let fixture_text: Option<String> = {
        let conn = state.db.lock().unwrap();
        conn.query_row(
            "SELECT text_content FROM attachments WHERE id = ?1",
            [attachment_id],
            |r| r.get(0),
        )
        .ok()
        .flatten()
    };
    if row.remote_id.is_none() {
        if let Some(t) = fixture_text {
            return Ok((row, t.into_bytes()));
        }
        return Err("this demo attachment has no file contents".into());
    }
    let account: Option<String> = {
        let conn = state.db.lock().unwrap();
        conn.query_row(
            "SELECT account_id FROM threads WHERE id = (SELECT thread_id FROM messages WHERE id = ?1)",
            [row.message_id.as_str()],
            |r| r.get(0),
        )
        .ok()
    };
    let account = account.ok_or("the attachment's account is gone")?;
    let remote = row.remote_id.clone().unwrap();
    let mut sessions = state.gmail.lock().await;
    let s = sessions
        .get_mut(&account)
        .ok_or("account not connected — reconnect Gmail to download")?;
    let bytes = s.get_attachment_bytes(&state.http, &row.message_id, &remote).await?;
    if bytes.len() <= 25_000_000 {
        let conn = state.db.lock().unwrap();
        let _ = store::set_attachment_data(&conn, attachment_id, &bytes);
    }
    Ok((row, bytes))
}

/// Save an attachment via the OS file dialog. None = user cancelled.
#[tauri::command]
async fn download_attachment(
    app: AppHandle,
    state: State<'_, AppState>,
    attachment_id: String,
) -> Result<Option<String>, String> {
    valid_id(&attachment_id)?;
    let (row, bytes) = attachment_bytes(&state, &attachment_id).await?;
    use tauri_plugin_dialog::DialogExt;
    let picked = app.dialog().file().set_file_name(&row.filename).blocking_save_file();
    let Some(picked) = picked else { return Ok(None) };
    let path = picked.into_path().map_err(|e| e.to_string())?;
    std::fs::write(&path, &bytes).map_err(|e| format!("could not write the file: {e}"))?;
    Ok(Some(path.display().to_string()))
}

/// Open an attachment with its default app (written to the app cache first).
#[tauri::command]
async fn open_attachment(
    app: AppHandle,
    state: State<'_, AppState>,
    attachment_id: String,
) -> Result<(), String> {
    valid_id(&attachment_id)?;
    let (row, bytes) = attachment_bytes(&state, &attachment_id).await?;
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join("attachments");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let safe_name: String = row
        .filename
        .chars()
        .map(|c| if c.is_alphanumeric() || ".-_ ".contains(c) { c } else { '_' })
        .collect();
    let safe_name = if safe_name.trim().is_empty() { "attachment".into() } else { safe_name };
    let path = dir.join(safe_name);
    std::fs::write(&path, &bytes).map_err(|e| e.to_string())?;
    tauri_plugin_opener::open_path(&path, None::<String>)
        .map_err(|_| "could not open the attachment".to_string())
}

// ---------------------------------------------------------------- drafts

#[tauri::command]
fn save_draft(
    state: State<'_, AppState>,
    draft_id: Option<i64>,
    payload: String,
) -> Result<i64, String> {
    if payload.len() > 40_000_000 {
        return Err("draft is too large".into());
    }
    let conn = state.db.lock().unwrap();
    let account = store::get_accounts(&conn).active;
    store::draft_save(&conn, draft_id, &account, &payload, now_ms())
}

#[tauri::command]
fn list_drafts(state: State<'_, AppState>) -> Vec<DraftEntry> {
    let conn = state.db.lock().unwrap();
    let account = store::get_accounts(&conn).active;
    store::draft_list(&conn, &account)
        .into_iter()
        .map(|(id, payload, updated_at)| DraftEntry { id, payload, updated_at })
        .collect()
}

#[tauri::command]
fn delete_draft(state: State<'_, AppState>, draft_id: i64) {
    store::draft_delete(&state.db.lock().unwrap(), draft_id);
}

#[tauri::command]
fn search_threads(state: State<'_, AppState>, query: String) -> Result<Vec<SearchResult>, String> {
    if query.len() > 200 {
        return Err("query too long".into());
    }
    let conn = state.db.lock().unwrap();
    let active = store::get_accounts(&conn).active;
    store::search(&conn, &query, &active)
}

#[tauri::command]
fn list_labels(state: State<'_, AppState>) -> Result<Vec<String>, String> {
    store::list_labels(&state.db.lock().unwrap())
}

// ---------------------------------------------------------------- triage

/// A pending Gmail-side triage change, applied in the background after the local
/// store write. Label names (not ids) so user labels like "Muted" work alongside
/// system labels (resolved via ensure_label_id, which returns system labels as-is).
enum RemoteTriage {
    Modify { add: Vec<String>, remove: Vec<String> },
    Trash,
    /// Untrash, then add these labels (restore from Trash → back to the inbox).
    UntrashAdd(Vec<String>),
}

fn s(v: &str) -> String {
    v.to_string()
}

/// Instant, non-blocking check that a triage action can reach Gmail: Ok for mock
/// threads and real threads whose account has a live session; Err (before any
/// local write) when a real thread's account has no live session, so the UI can't
/// silently diverge from Gmail. Uses try_lock so a sync holding the gmail mutex
/// never stalls triage — if we can't peek instantly we assume connected and let
/// the background op surface any failure. (BUG 3a)
fn ensure_remote_capable(state: &State<'_, AppState>, thread_id: &str) -> Result<(), String> {
    if is_mock_id(thread_id) {
        return Ok(());
    }
    let account = {
        let conn = state.db.lock().unwrap();
        store::account_of_thread(&conn, thread_id)
    };
    let Some(account) = account else { return Ok(()) };
    if let Ok(sessions) = state.gmail.try_lock() {
        if !sessions.contains_key(&account) {
            return Err("account not connected — reconnect Gmail in Settings → Account, then try again".into());
        }
    }
    Ok(())
}

/// Apply a triage change on Gmail in the background so the command returns as soon
/// as the local store write lands. On failure, surface it (never silent) and
/// reconcile the affected thread so the optimistic local change is corrected
/// rather than diverging. (BUG 2 #2 / BUG 3)
fn spawn_remote(app: AppHandle, thread_id: String, op: RemoteTriage) {
    if is_mock_id(&thread_id) {
        return;
    }
    tauri::async_runtime::spawn(async move {
        let state = app.state::<AppState>();
        let account = {
            let conn = state.db.lock().unwrap();
            store::account_of_thread(&conn, &thread_id)
        };
        let Some(account) = account else { return };
        let result: Result<(), String> = async {
            let mut sessions = state.gmail.lock().await;
            let sess = sessions
                .get_mut(&account)
                .ok_or("account not connected — reconnect Gmail")?;
            match &op {
                RemoteTriage::Modify { add, remove } => {
                    let mut add_ids = Vec::with_capacity(add.len());
                    for name in add {
                        add_ids.push(sess.ensure_label_id(&state.http, name).await?);
                    }
                    let mut rem_ids = Vec::with_capacity(remove.len());
                    for name in remove {
                        rem_ids.push(sess.ensure_label_id(&state.http, name).await?);
                    }
                    let add_refs: Vec<&str> = add_ids.iter().map(String::as_str).collect();
                    let rem_refs: Vec<&str> = rem_ids.iter().map(String::as_str).collect();
                    sess.modify_thread(&state.http, &thread_id, &add_refs, &rem_refs).await
                }
                RemoteTriage::Trash => sess.trash_thread(&state.http, &thread_id).await,
                RemoteTriage::UntrashAdd(add) => {
                    sess.untrash_thread(&state.http, &thread_id).await?;
                    let mut add_ids = Vec::with_capacity(add.len());
                    for name in add {
                        add_ids.push(sess.ensure_label_id(&state.http, name).await?);
                    }
                    let add_refs: Vec<&str> = add_ids.iter().map(String::as_str).collect();
                    sess.modify_thread(&state.http, &thread_id, &add_refs, &[]).await
                }
            }
        }
        .await;
        if let Err(e) = result {
            eprintln!("[triage:{account}] remote update failed: {e}");
            let _ = app.emit("triage:error", format!("Couldn't sync to Gmail: {e}"));
            // reconcile the thread so local state matches the server
            let mut sessions = state.gmail.lock().await;
            if let Some(sess) = sessions.get_mut(&account) {
                let _ = mail::sync::refetch_thread(&state.http, sess, &state.db, &account, &thread_id).await;
            }
            drop(sessions);
            let _ = app.emit("mail:updated", ());
        }
    });
}

#[tauri::command]
async fn archive_thread(app: AppHandle, state: State<'_, AppState>, thread_id: String) -> Result<(), String> {
    valid_id(&thread_id)?;
    ensure_remote_capable(&state, &thread_id)?;
    store::set_in_inbox(&state.db.lock().unwrap(), &thread_id, false)?;
    spawn_remote(app, thread_id, RemoteTriage::Modify { add: vec![], remove: vec![s("INBOX")] });
    Ok(())
}

#[tauri::command]
async fn move_to_inbox(app: AppHandle, state: State<'_, AppState>, thread_id: String) -> Result<(), String> {
    valid_id(&thread_id)?;
    ensure_remote_capable(&state, &thread_id)?;
    store::set_in_inbox(&state.db.lock().unwrap(), &thread_id, true)?;
    spawn_remote(app, thread_id, RemoteTriage::Modify { add: vec![s("INBOX")], remove: vec![] });
    Ok(())
}

/// Trash or spam a thread. Soft-hide locally (so Z can restore instantly);
/// server-side it goes to Gmail's Trash / Spam (in the background).
#[tauri::command]
async fn hide_thread(
    app: AppHandle,
    state: State<'_, AppState>,
    thread_id: String,
    reason: String,
) -> Result<(), String> {
    valid_id(&thread_id)?;
    if !matches!(reason.as_str(), "trash" | "spam") {
        return Err("invalid reason".into());
    }
    ensure_remote_capable(&state, &thread_id)?;
    store::set_hidden(&state.db.lock().unwrap(), &thread_id, Some(&reason))?;
    let op = if reason == "trash" {
        RemoteTriage::Trash
    } else {
        RemoteTriage::Modify { add: vec![s("SPAM")], remove: vec![s("INBOX")] }
    };
    spawn_remote(app, thread_id, op);
    Ok(())
}

/// Undo for hide_thread: untrash/unspam remotely, resurface locally.
#[tauri::command]
async fn restore_thread(app: AppHandle, state: State<'_, AppState>, thread_id: String) -> Result<(), String> {
    valid_id(&thread_id)?;
    let reason = store::hidden_reason(&state.db.lock().unwrap(), &thread_id);
    ensure_remote_capable(&state, &thread_id)?;
    store::set_hidden(&state.db.lock().unwrap(), &thread_id, None)?;
    match reason.as_deref() {
        Some("trash") => spawn_remote(app, thread_id, RemoteTriage::UntrashAdd(vec![s("INBOX")])),
        Some("spam") => spawn_remote(
            app,
            thread_id,
            RemoteTriage::Modify { add: vec![s("INBOX")], remove: vec![s("SPAM")] },
        ),
        _ => {}
    }
    Ok(())
}

/// Mute: archive now and keep auto-archiving new replies (via the sync pass).
#[tauri::command]
async fn mute_thread(app: AppHandle, state: State<'_, AppState>, thread_id: String) -> Result<(), String> {
    valid_id(&thread_id)?;
    ensure_remote_capable(&state, &thread_id)?;
    let already_muted = {
        let conn = state.db.lock().unwrap();
        let muted = store::get_thread(&conn, &thread_id)
            .map(|t| t.labels.iter().any(|l| l == "Muted"))
            .unwrap_or(false);
        if !muted {
            store::toggle_label(&conn, &thread_id, "Muted")?;
        }
        store::set_in_inbox(&conn, &thread_id, false)?;
        muted
    };
    let add = if already_muted { vec![] } else { vec![s("Muted")] };
    spawn_remote(app, thread_id, RemoteTriage::Modify { add, remove: vec![s("INBOX")] });
    Ok(())
}

#[tauri::command]
async fn unmute_thread(app: AppHandle, state: State<'_, AppState>, thread_id: String) -> Result<(), String> {
    valid_id(&thread_id)?;
    ensure_remote_capable(&state, &thread_id)?;
    let was_muted = {
        let conn = state.db.lock().unwrap();
        let muted = store::get_thread(&conn, &thread_id)
            .map(|t| t.labels.iter().any(|l| l == "Muted"))
            .unwrap_or(false);
        if muted {
            store::toggle_label(&conn, &thread_id, "Muted")?;
        }
        store::set_in_inbox(&conn, &thread_id, true)?;
        muted
    };
    let remove = if was_muted { vec![s("Muted")] } else { vec![] };
    spawn_remote(app, thread_id, RemoteTriage::Modify { add: vec![s("INBOX")], remove });
    Ok(())
}

#[tauri::command]
fn unsubscribe_thread(
    app: AppHandle,
    state: State<'_, AppState>,
    thread_id: String,
) -> Result<UnsubResult, String> {
    valid_id(&thread_id)?;
    let header = store::unsubscribe_header(&state.db.lock().unwrap(), &thread_id);
    let Some(header) = header else {
        return Ok(UnsubResult { kind: "none".into(), target: None });
    };
    match mail::gmail::parse_unsubscribe_target(&header) {
        Some((kind, target)) if kind == "opened" => {
            let _ = app; // opener plugin is app-scoped
            tauri_plugin_opener::open_url(&target, None::<String>)
                .map_err(|_| "could not open the unsubscribe page".to_string())?;
            Ok(UnsubResult { kind, target: Some(target) })
        }
        Some((kind, target)) => Ok(UnsubResult { kind, target: Some(target) }),
        None => Ok(UnsubResult { kind: "none".into(), target: None }),
    }
}

#[tauri::command]
async fn toggle_star(app: AppHandle, state: State<'_, AppState>, thread_id: String) -> Result<bool, String> {
    valid_id(&thread_id)?;
    ensure_remote_capable(&state, &thread_id)?;
    let starred = {
        let conn = state.db.lock().unwrap();
        let t = store::get_thread(&conn, &thread_id).ok_or("unknown thread")?;
        let starred = !t.starred;
        store::set_starred(&conn, &thread_id, starred)?;
        starred
    };
    let op = if starred {
        RemoteTriage::Modify { add: vec![s("STARRED")], remove: vec![] }
    } else {
        RemoteTriage::Modify { add: vec![], remove: vec![s("STARRED")] }
    };
    spawn_remote(app, thread_id, op);
    Ok(starred)
}

#[tauri::command]
async fn snooze_thread(
    app: AppHandle,
    state: State<'_, AppState>,
    thread_id: String,
    until_ms: i64,
) -> Result<(), String> {
    valid_id(&thread_id)?;
    if until_ms <= now_ms() {
        return Err("snooze time must be in the future".into());
    }
    ensure_remote_capable(&state, &thread_id)?;
    store::set_snoozed(&state.db.lock().unwrap(), &thread_id, until_ms)?;
    spawn_remote(app, thread_id, RemoteTriage::Modify { add: vec![], remove: vec![s("INBOX")] });
    Ok(())
}

#[tauri::command]
async fn mark_unread(app: AppHandle, state: State<'_, AppState>, thread_id: String) -> Result<(), String> {
    valid_id(&thread_id)?;
    ensure_remote_capable(&state, &thread_id)?;
    store::set_unread(&state.db.lock().unwrap(), &thread_id, true)?;
    spawn_remote(app, thread_id, RemoteTriage::Modify { add: vec![s("UNREAD")], remove: vec![] });
    Ok(())
}

#[tauri::command]
async fn mark_read(app: AppHandle, state: State<'_, AppState>, thread_id: String) -> Result<(), String> {
    valid_id(&thread_id)?;
    ensure_remote_capable(&state, &thread_id)?;
    store::set_unread(&state.db.lock().unwrap(), &thread_id, false)?;
    spawn_remote(app, thread_id, RemoteTriage::Modify { add: vec![], remove: vec![s("UNREAD")] });
    Ok(())
}

#[tauri::command]
async fn move_label(
    app: AppHandle,
    state: State<'_, AppState>,
    thread_id: String,
    label: String,
) -> Result<(), String> {
    valid_id(&thread_id)?;
    if label.is_empty() || label.len() > 100 {
        return Err("invalid label".into());
    }
    ensure_remote_capable(&state, &thread_id)?;
    let added = {
        let conn = state.db.lock().unwrap();
        store::toggle_label(&conn, &thread_id, &label)?
    };
    let op = if added {
        RemoteTriage::Modify { add: vec![label], remove: vec![] }
    } else {
        RemoteTriage::Modify { add: vec![], remove: vec![label] }
    };
    spawn_remote(app, thread_id, op);
    Ok(())
}

#[tauri::command]
async fn bulk_archive(
    app: AppHandle,
    state: State<'_, AppState>,
    opts: BulkArchiveOpts,
) -> Result<i64, String> {
    let (targets, settings, active) = {
        let conn = state.db.lock().unwrap();
        let active = store::get_accounts(&conn).active;
        (store::inbox_threads_for_sweep(&conn, &active)?, store::get_settings(&conn), active)
    };
    let cutoff = now_ms() - opts.older_than_days * 24 * 3_600_000;
    let mut ids: Vec<String> = vec![];
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
        ids.push(t.id);
    }
    // Local writes are synchronous (instant); archive on Gmail in the background.
    {
        let conn = state.db.lock().unwrap();
        for id in &ids {
            store::set_in_inbox(&conn, id, false)?;
        }
    }
    let n = ids.len() as i64;
    let remote_ids: Vec<String> = ids.into_iter().filter(|id| !is_mock_id(id)).collect();
    if !remote_ids.is_empty() {
        let app2 = app.clone();
        tauri::async_runtime::spawn(async move {
            let state = app2.state::<AppState>();
            let mut sessions = state.gmail.lock().await;
            if let Some(sess) = sessions.get_mut(&active) {
                for id in remote_ids {
                    if let Err(e) = sess.modify_thread(&state.http, &id, &[], &["INBOX"]).await {
                        eprintln!("[bulk_archive:{active}] {id}: {e}");
                    }
                }
            }
        });
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

fn validate_mail(mail: &OutgoingMail) -> Result<(), String> {
    if mail.to.is_empty() {
        return Err("add at least one recipient".into());
    }
    for addr in mail.to.iter().chain(mail.cc.iter()) {
        if !addr.contains('@') || addr.len() > 254 || addr.contains(['\r', '\n']) {
            return Err(format!("\"{addr}\" is not a valid address"));
        }
    }
    // Gmail rejects raw messages over ~25 MB; base64 inflates by ~4/3.
    let total: usize = mail.attachments.iter().map(|a| a.data_base64.len()).sum();
    if total > 33_000_000 {
        return Err("attachments exceed the 25 MB limit".into());
    }
    for a in &mail.attachments {
        if a.filename.is_empty() || a.filename.len() > 255 {
            return Err("attachment has an invalid filename".into());
        }
    }
    Ok(())
}

/// Actually deliver a message for a given account: Gmail send for connected
/// accounts, local append in demo mode. Used by the outbox processor.
async fn deliver_mail(app: &AppHandle, account_email: &str, mail: &OutgoingMail) -> Result<(), String> {
    let state = app.state::<AppState>();
    let provider = {
        let conn = state.db.lock().unwrap();
        store::get_accounts(&conn)
            .accounts
            .iter()
            .find(|a| a.email == account_email)
            .map(|a| a.provider.clone())
            .unwrap_or_else(|| "mock".into())
    };

    if provider == "gmail" && !mail.thread_id.as_deref().map(is_mock_id).unwrap_or(false) {
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
        let raw = mail::gmail::build_rfc822(account_email, mail, in_reply_to.as_deref());
        let mut sessions = state.gmail.lock().await;
        let session = sessions
            .get_mut(account_email)
            .ok_or("Gmail session unavailable for this account")?;
        session.send(&state.http, &raw, mail.thread_id.as_deref()).await?;
        drop(sessions);
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
        from: account_email.to_string(),
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
            participants: vec![format!("You <{account_email}>")],
            message_count: 1,
            last_date: now,
            unread: false,
            starred: false,
            labels: vec![],
            in_inbox: false,
            snoozed_until: None,
        },
    };
    store::upsert_thread(&conn, account_email, &thread, &[(msg, None, None, vec![])])?;
    Ok(())
}

/// Queue a message. delay_ms ≈ 10s gives the Undo Send window; larger values
/// are Send Later. The outbox survives app restarts.
#[tauri::command]
fn queue_mail(state: State<'_, AppState>, mail: OutgoingMail, delay_ms: i64) -> Result<i64, String> {
    validate_mail(&mail)?;
    if !(0..=90 * 24 * 3_600_000).contains(&delay_ms) {
        return Err("invalid send delay".into());
    }
    let conn = state.db.lock().unwrap();
    let account = store::get_accounts(&conn).active;
    store::outbox_add(&conn, &account, &mail, now_ms() + delay_ms)
}

/// Undo Send: pull a message back before the outbox flushes it.
#[tauri::command]
fn cancel_outbox(state: State<'_, AppState>, outbox_id: i64) -> Result<OutgoingMail, String> {
    store::outbox_cancel(&state.db.lock().unwrap(), outbox_id)
        .ok_or("already sent".to_string())
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
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            let db_path = data_dir.join("fission.db");
            // Migrate a pre-rename install: the old bundle identifier
            // (com.zenbox.mail) had its own app-data dir with zenbox.db. Copy it
            // (with its WAL sidecars) once so accounts + cached mail carry over.
            // Keychain secrets migrate lazily in secrets::get.
            if !db_path.exists() {
                if let Some(old_dir) = data_dir.parent().map(|p| p.join("com.zenbox.mail")) {
                    for (from, to) in [
                        ("zenbox.db", "fission.db"),
                        ("zenbox.db-wal", "fission.db-wal"),
                        ("zenbox.db-shm", "fission.db-shm"),
                    ] {
                        let src = old_dir.join(from);
                        if src.exists() {
                            let _ = std::fs::copy(&src, data_dir.join(to));
                        }
                    }
                }
            }
            let conn = store::open(&db_path).map_err(std::io::Error::other)?;

            let accounts = store::get_accounts(&conn);
            let mut sessions = HashMap::new();
            let mut lost_accounts = vec![];
            for a in &accounts.accounts {
                match a.provider.as_str() {
                    "gmail" => match GmailSession::from_keychain(a.email.clone()) {
                        Some(s) => {
                            sessions.insert(a.email.clone(), s);
                        }
                        None => lost_accounts.push(a.email.clone()),
                    },
                    _ => {
                        mail::mock::seed_if_empty(&conn).map_err(std::io::Error::other)?;
                    }
                }
            }
            // tokens removed out-of-band: drop those accounts gracefully
            if !lost_accounts.is_empty() {
                let mut acc = accounts.clone();
                acc.accounts.retain(|a| !lost_accounts.contains(&a.email));
                if acc.accounts.is_empty() {
                    conn.execute("DELETE FROM kv WHERE key = 'accounts'", []).ok();
                    let _ = mail::mock::seed_if_empty(&conn);
                } else {
                    if !acc.accounts.iter().any(|a| a.email == acc.active) {
                        acc.active = acc.accounts[0].email.clone();
                    }
                    let _ = store::save_accounts(&conn, &acc);
                }
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
                gmail: tokio::sync::Mutex::new(sessions),
                cancels: Mutex::new(HashMap::new()),
            });

            // Dev-only: FISSION_AI_SMOKE=1 streams one real draft at startup and
            // logs the result — end-to-end proof of context assembly + adapter
            // + SSE parsing against the configured default provider.
            #[cfg(debug_assertions)]
            if std::env::var("FISSION_AI_SMOKE").is_ok() {
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    let state = handle.state::<AppState>();
                    let settings = store::get_settings(&state.db.lock().unwrap());
                    let p = match ai::resolve(&settings, None) {
                        Ok(p) => p,
                        Err(e) => return eprintln!("[ai-smoke] resolve: {e}"),
                    };
                    let req = DraftRequest {
                        thread_id: Some("t-term-sheet".into()),
                        instruction: "Summarize this thread in one short sentence.".into(),
                        existing_text: None,
                        provider_id: None,
                    };
                    let ctx = match ai::context::assemble(&state.db, &state.http, &state.gmail, &req, false).await {
                        Ok(c) => c,
                        Err(e) => return eprintln!("[ai-smoke] assemble: {e}"),
                    };
                    let mut acc = String::new();
                    match ai::stream_draft(
                        &state.http,
                        &p,
                        &ctx,
                        |c| acc.push_str(&c),
                        Arc::new(AtomicBool::new(false)),
                    )
                    .await
                    {
                        Ok(()) => eprintln!(
                            "[ai-smoke] OK {} / {} — {} chars streamed: {}",
                            p.id,
                            p.model,
                            acc.len(),
                            acc.replace('\n', " ").chars().take(140).collect::<String>()
                        ),
                        Err(e) => eprintln!("[ai-smoke] stream: {e}"),
                    }
                });
            }

            // outbox processor: flushes due sends every 3s (10s undo window,
            // Send Later, and retry with a 5-attempt cap)
            let outbox_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                loop {
                    tokio::time::sleep(std::time::Duration::from_secs(3)).await;
                    let state = outbox_handle.state::<AppState>();
                    let due = {
                        let conn = state.db.lock().unwrap();
                        store::outbox_due(&conn, now_ms())
                    };
                    let mut sent_any = false;
                    for (id, account, mail) in due {
                        match deliver_mail(&outbox_handle, &account, &mail).await {
                            Ok(()) => {
                                let conn = state.db.lock().unwrap();
                                store::outbox_delete(&conn, id);
                                sent_any = true;
                            }
                            Err(e) => {
                                eprintln!("[outbox] send failed (will retry): {e}");
                                let conn = state.db.lock().unwrap();
                                store::outbox_bump_attempts(&conn, id);
                            }
                        }
                    }
                    if sent_any {
                        let _ = outbox_handle.emit("mail:updated", ());
                    }
                }
            });

            // one forced reconcile at startup: refreshes the inbox immediately on
            // launch and sweeps any server-side removals missed while closed
            let boot = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let state = boot.state::<AppState>();
                let mut changed = false;
                {
                    let mut sessions = state.gmail.lock().await;
                    for (email, session) in sessions.iter_mut() {
                        if let Ok(c) =
                            mail::sync::full_sync(&state.http, session, &state.db, email, true).await
                        {
                            changed |= c;
                        }
                    }
                }
                if changed {
                    let _ = boot.emit("mail:updated", ());
                }
            });

            // background loop: snooze wake-ups + Gmail sync every 30s, with a
            // full reconcile every ~10 min as the inbox-removal safety net
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let mut tick: u64 = 0;
                // only mail that arrives after boot notifies — no backlog blast
                let mut notify_watermark = now_ms();
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
                        let mut sessions = state.gmail.lock().await;
                        for id in &woke {
                            if is_mock_id(id) {
                                continue;
                            }
                            let account = {
                                let conn = state.db.lock().unwrap();
                                store::account_of_thread(&conn, id)
                            };
                            if let Some(account) = account {
                                if let Some(session) = sessions.get_mut(&account) {
                                    let _ = session
                                        .modify_thread(&state.http, id, &["INBOX", "UNREAD"], &[])
                                        .await;
                                }
                            }
                        }
                        // Sync every tick (30s) for responsive two-way sync; a
                        // full reconcile every 20th tick (~10 min) sweeps inbox
                        // removals the incremental path can miss.
                        let force = tick % 20 == 0;
                        for (email, session) in sessions.iter_mut() {
                            if let Ok(c) =
                                mail::sync::full_sync(&state.http, session, &state.db, email, force).await
                            {
                                changed |= c;
                            }
                        }
                    }
                    // Calendar cache refresh: 30s after boot, then every ~5 min
                    // (rolling window of a week back and three ahead), so the
                    // panel paints instantly from SQLite.
                    if tick % 10 == 1 {
                        let emails: Vec<String> = {
                            let conn = state.db.lock().unwrap();
                            store::get_accounts(&conn)
                                .accounts
                                .iter()
                                .filter(|a| a.provider == "gmail")
                                .map(|a| a.email.clone())
                                .collect()
                        };
                        let day_start = chrono::Local::now()
                            .date_naive()
                            .and_hms_opt(0, 0, 0)
                            .and_then(|t| t.and_local_timezone(chrono::Local).single())
                            .map(|t| t.timestamp_millis())
                            .unwrap_or_else(now_ms);
                        for email in emails {
                            spawn_calendar_refresh(
                                handle.clone(),
                                email,
                                day_start - 7 * DAY_MS,
                                day_start + 21 * DAY_MS,
                            );
                        }
                    }
                    if changed {
                        let _ = handle.emit("mail:updated", ());
                        notify_new_mail(&handle, notify_watermark);
                        notify_watermark = now_ms();
                    }
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_accounts,
            switch_account,
            reorder_accounts,
            has_gmail_client,
            start_oauth,
            disconnect_account,
            sync_now,
            resync_account,
            list_threads,
            get_thread,
            refetch_message_body,
            search_threads,
            list_labels,
            archive_thread,
            move_to_inbox,
            hide_thread,
            restore_thread,
            mute_thread,
            unmute_thread,
            unsubscribe_thread,
            toggle_star,
            snooze_thread,
            mark_unread,
            mark_read,
            move_label,
            bulk_archive,
            queue_mail,
            cancel_outbox,
            download_attachment,
            open_attachment,
            save_draft,
            list_drafts,
            delete_draft,
            get_profile,
            set_profile_photo,
            list_events,
            refresh_calendar,
            get_daily_photo,
            photo_shown,
            set_unsplash_key,
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
        .expect("error while running Fission Mail");
}
