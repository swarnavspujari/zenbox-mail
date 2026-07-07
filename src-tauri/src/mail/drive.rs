//! Google Drive for the composer: search/recents for the picker, download-as-
//! attachment, resumable uploads into the app folder (oversized attachments
//! become share links), and share-on-send permissions. Rides the account's
//! Gmail OAuth session — the `drive` scope is requested at connect (v0.12+).
//!
//! Upload transport: the webview slices the file into 4 MiB chunks (a multiple
//! of Google's required 256 KiB) and hands each to `drive_upload_chunk` as a
//! raw invoke body; this module PUTs them to the resumable session URI with
//! `Content-Range`. No base64 JSON, bounded memory, frontend-derived progress.
use crate::mail::gmail::GmailSession;
use crate::types::{DriveFile, MailAttachment};
use base64::Engine;
use serde_json::{json, Value};

const FILES: &str = "https://www.googleapis.com/drive/v3/files";
const UPLOAD: &str = "https://www.googleapis.com/upload/drive/v3/files";
const FILE_FIELDS: &str = "id,name,mimeType,size,webViewLink,iconLink,modifiedTime,owners(displayName)";
pub const APP_FOLDER_NAME: &str = "Fission Mail Attachments";
/// Attach-as-copy ceiling — Gmail's inline attachment limit (bytes).
pub const INLINE_LIMIT: i64 = 25_000_000;

fn classify(e: &str) -> String {
    crate::mail::classify_google_error(e, "Google Drive API", "Drive")
}

fn urlenc(s: &str) -> String {
    url::form_urlencoded::byte_serialize(s.as_bytes()).collect()
}

/// Drive query strings quote values with single quotes; escape accordingly.
fn escape_q(s: &str) -> String {
    s.replace('\\', "\\\\").replace('\'', "\\'")
}

/// Drive serializes int64 as a JSON string.
fn parse_size(v: &Value) -> Option<i64> {
    v.as_str().and_then(|s| s.parse().ok()).or_else(|| v.as_i64())
}

pub fn parse_file(v: &Value) -> DriveFile {
    DriveFile {
        id: v["id"].as_str().unwrap_or_default().to_string(),
        name: v["name"].as_str().unwrap_or_default().to_string(),
        mime_type: v["mimeType"].as_str().unwrap_or_default().to_string(),
        size: parse_size(&v["size"]),
        web_view_link: v["webViewLink"].as_str().unwrap_or_default().to_string(),
        icon_link: v["iconLink"].as_str().map(str::to_string),
        modified_time: v["modifiedTime"].as_str().map(str::to_string),
        owner: v["owners"][0]["displayName"].as_str().map(str::to_string),
    }
}

/// One page of files. Empty query = recents (most recently viewed first);
/// otherwise name + full-text matching (orderBy is invalid with fullText, so
/// search results keep Drive's relevance order).
pub async fn search(
    http: &reqwest::Client,
    session: &mut GmailSession,
    query: &str,
    page_token: Option<&str>,
) -> Result<(Vec<DriveFile>, Option<String>), String> {
    let q = if query.trim().is_empty() {
        "trashed = false".to_string()
    } else {
        let esc = escape_q(query.trim());
        format!("trashed = false and (name contains '{esc}' or fullText contains '{esc}')")
    };
    let mut url = format!(
        "{FILES}?pageSize=30&supportsAllDrives=true&includeItemsFromAllDrives=true&q={}&fields={}",
        urlenc(&q),
        urlenc(&format!("nextPageToken,files({FILE_FIELDS})")),
    );
    if query.trim().is_empty() {
        url.push_str("&orderBy=viewedByMeTime%20desc");
    }
    if let Some(t) = page_token {
        url.push_str(&format!("&pageToken={}", urlenc(t)));
    }
    let v = session.get_json(http, &url).await.map_err(|e| classify(&e))?;
    let empty = vec![];
    let files = v["files"]
        .as_array()
        .unwrap_or(&empty)
        .iter()
        .map(parse_file)
        .collect();
    Ok((files, v["nextPageToken"].as_str().map(str::to_string)))
}

pub async fn file_meta(
    http: &reqwest::Client,
    session: &mut GmailSession,
    file_id: &str,
) -> Result<DriveFile, String> {
    let url = format!(
        "{FILES}/{}?supportsAllDrives=true&fields={}",
        urlenc(file_id),
        urlenc(FILE_FIELDS)
    );
    let v = session.get_json(http, &url).await.map_err(|e| classify(&e))?;
    Ok(parse_file(&v))
}

/// Download a Drive file's bytes as an outgoing attachment ("attach as copy").
/// Size-gated on metadata BEFORE the bytes move.
pub async fn download(
    http: &reqwest::Client,
    session: &mut GmailSession,
    file_id: &str,
) -> Result<MailAttachment, String> {
    let meta = file_meta(http, session, file_id).await?;
    if meta.mime_type.starts_with("application/vnd.google-apps") {
        return Err("Google Docs/Sheets/Slides can't be attached as a copy — insert the link instead".into());
    }
    match meta.size {
        Some(s) if s <= INLINE_LIMIT => {}
        Some(_) => return Err("that file is over the 25 MB attachment limit — insert the link instead".into()),
        None => return Err("that file has no downloadable content — insert the link instead".into()),
    }
    let token = session.bearer(http).await?;
    let url = format!("{FILES}/{}?alt=media&supportsAllDrives=true", urlenc(file_id));
    let resp = http
        .get(&url)
        .bearer_auth(&token)
        .send()
        .await
        .map_err(|_| "Drive download failed (network)".to_string())?;
    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        let snippet: String = body.chars().take(500).collect();
        return Err(classify(&format!("Drive API error ({status}): {snippet}")));
    }
    let bytes = resp
        .bytes()
        .await
        .map_err(|_| "Drive download was interrupted".to_string())?;
    if bytes.len() as i64 > INLINE_LIMIT {
        return Err("that file is over the 25 MB attachment limit — insert the link instead".into());
    }
    Ok(MailAttachment {
        filename: meta.name,
        mime_type: if meta.mime_type.is_empty() {
            "application/octet-stream".into()
        } else {
            meta.mime_type
        },
        data_base64: base64::engine::general_purpose::STANDARD.encode(&bytes),
    })
}

/// Does this file id still exist (and sit outside the trash)?
pub async fn folder_alive(
    http: &reqwest::Client,
    session: &mut GmailSession,
    folder_id: &str,
) -> bool {
    let url = format!("{FILES}/{}?fields=id,trashed", urlenc(folder_id));
    match session.get_json(http, &url).await {
        Ok(v) => v["trashed"].as_bool() != Some(true),
        Err(_) => false,
    }
}

/// Find (or create) the app's upload folder in My Drive root.
pub async fn find_or_create_app_folder(
    http: &reqwest::Client,
    session: &mut GmailSession,
) -> Result<String, String> {
    let q = format!(
        "name = '{}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false and 'root' in parents",
        escape_q(APP_FOLDER_NAME)
    );
    let url = format!("{FILES}?q={}&fields=files(id)&pageSize=1", urlenc(&q));
    let v = session.get_json(http, &url).await.map_err(|e| classify(&e))?;
    if let Some(id) = v["files"][0]["id"].as_str() {
        return Ok(id.to_string());
    }
    let token = session.bearer(http).await?;
    let resp = http
        .post(format!("{FILES}?fields=id"))
        .bearer_auth(&token)
        .json(&json!({ "name": APP_FOLDER_NAME, "mimeType": "application/vnd.google-apps.folder" }))
        .send()
        .await
        .map_err(|_| "Drive folder create failed (network)".to_string())?;
    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(classify(&format!(
            "Drive API error ({status}): {}",
            body.chars().take(500).collect::<String>()
        )));
    }
    let v: Value = resp
        .json()
        .await
        .map_err(|_| "Drive returned an unexpected response".to_string())?;
    v["id"]
        .as_str()
        .map(str::to_string)
        .ok_or("Drive folder create returned no id".to_string())
}

/// Open a resumable upload session; returns the session URI (valid ~1 week).
pub async fn upload_begin(
    http: &reqwest::Client,
    session: &mut GmailSession,
    folder_id: &str,
    filename: &str,
    mime: &str,
    size: i64,
) -> Result<String, String> {
    let token = session.bearer(http).await?;
    let url = format!(
        "{UPLOAD}?uploadType=resumable&supportsAllDrives=true&fields={}",
        urlenc(FILE_FIELDS)
    );
    let resp = http
        .post(&url)
        .bearer_auth(&token)
        .header("X-Upload-Content-Type", mime)
        .header("X-Upload-Content-Length", size.to_string())
        .json(&json!({ "name": filename, "parents": [folder_id] }))
        .send()
        .await
        .map_err(|_| "Drive upload could not start (network)".to_string())?;
    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(classify(&format!(
            "Drive API error ({status}): {}",
            body.chars().take(500).collect::<String>()
        )));
    }
    resp.headers()
        .get("location")
        .and_then(|h| h.to_str().ok())
        .map(str::to_string)
        .ok_or("Drive did not return an upload session".to_string())
}

/// Outcome of one chunk PUT.
pub enum ChunkOutcome {
    /// 308 — keep sending. `next_offset` is the server's high-water mark
    /// (from the 308's Range header) when it reported one: the server may
    /// persist FEWER bytes than were sent, and the next Content-Range must
    /// start from ITS offset, not the local counter.
    Continue { next_offset: Option<i64> },
    /// 200/201 — upload complete.
    Done(DriveFile),
}

/// Parse a 308's `Range: bytes=0-N` header into the next send offset (N+1).
fn range_next_offset(resp: &reqwest::Response) -> Option<i64> {
    let v = resp.headers().get("range")?.to_str().ok()?;
    let end = v.rsplit('-').next()?.trim();
    end.parse::<i64>().ok().map(|n| n + 1)
}

/// PUT one chunk to the session URI. Transient failures (429/5xx/network)
/// retry with backoff — a resumable session survives them by design, and
/// failing a multi-hundred-chunk upload over one blip would force a restart
/// from byte 0. 404 = session expired (restart).
pub async fn upload_chunk(
    http: &reqwest::Client,
    token: &str,
    session_uri: &str,
    offset: i64,
    total: i64,
    bytes: Vec<u8>,
) -> Result<ChunkOutcome, String> {
    let end = offset + bytes.len() as i64 - 1;
    for attempt in 0..3u32 {
        let sent = http
            .put(session_uri)
            .bearer_auth(token)
            .header("Content-Range", format!("bytes {offset}-{end}/{total}"))
            .body(bytes.clone())
            .send()
            .await;
        let resp = match sent {
            Ok(r) => r,
            Err(_) => {
                tokio::time::sleep(std::time::Duration::from_millis(500 * 2u64.pow(attempt))).await;
                continue;
            }
        };
        let status = resp.status().as_u16();
        match status {
            308 => return Ok(ChunkOutcome::Continue { next_offset: range_next_offset(&resp) }),
            200 | 201 => {
                let v: Value = resp
                    .json()
                    .await
                    .map_err(|_| "Drive returned an unexpected response".to_string())?;
                return Ok(ChunkOutcome::Done(parse_file(&v)));
            }
            404 => return Err("the Drive upload session expired — try the upload again".into()),
            429 | 500..=599 => {
                tokio::time::sleep(std::time::Duration::from_millis(500 * 2u64.pow(attempt))).await;
                continue;
            }
            _ => {
                let body = resp.text().await.unwrap_or_default();
                return Err(classify(&format!(
                    "Drive API error ({status}): {}",
                    body.chars().take(500).collect::<String>()
                )));
            }
        }
    }
    Err("Drive upload kept failing — check your connection and try again".into())
}

/// Abandon a resumable session (best-effort; Google also expires them).
pub async fn upload_cancel(http: &reqwest::Client, session_uri: &str) {
    let _ = http.delete(session_uri).send().await;
}

/// Grant read access for send: mode "recipients" = one reader permission per
/// address (no notification mail — the message itself carries the link);
/// mode "anyone" = anyone-with-the-link reader. Returns the addresses that
/// could not be shared (send proceeds anyway; Gmail behaves the same).
pub async fn share(
    http: &reqwest::Client,
    session: &mut GmailSession,
    file_id: &str,
    mode: &str,
    emails: &[String],
) -> Result<Vec<String>, String> {
    let token = session.bearer(http).await?;
    let base = format!(
        "{FILES}/{}/permissions?supportsAllDrives=true",
        urlenc(file_id)
    );
    let post = |url: String, body: Value| {
        let http = http.clone();
        let token = token.clone();
        async move {
            let resp = http
                .post(&url)
                .bearer_auth(&token)
                .json(&body)
                .send()
                .await
                .map_err(|_| "Drive share failed (network)".to_string())?;
            if resp.status().is_success() {
                Ok(())
            } else {
                let status = resp.status();
                let body = resp.text().await.unwrap_or_default();
                Err(format!(
                    "Drive API error ({status}): {}",
                    body.chars().take(300).collect::<String>()
                ))
            }
        }
    };
    match mode {
        "anyone" => {
            post(base, json!({ "role": "reader", "type": "anyone" }))
                .await
                .map_err(|e| classify(&e))?;
            Ok(vec![])
        }
        "recipients" => {
            let mut failed = vec![];
            for email in emails {
                let url = format!("{base}&sendNotificationEmail=false");
                if post(url, json!({ "role": "reader", "type": "user", "emailAddress": email }))
                    .await
                    .is_err()
                {
                    failed.push(email.clone());
                }
            }
            Ok(failed)
        }
        _ => Err("invalid share mode".into()),
    }
}
