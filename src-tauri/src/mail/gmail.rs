//! Minimal Gmail REST client: exactly the calls ZenBox needs, nothing more.
use crate::mail::oauth;
use crate::secrets;
use crate::types::*;
use base64::Engine;
use serde_json::{json, Value};
use std::time::{Duration, Instant};

const BASE: &str = "https://gmail.googleapis.com/gmail/v1/users/me";

pub struct GmailSession {
    #[allow(dead_code)] // kept for multi-account support (P1)
    pub email: String,
    client_id: String,
    client_secret: String,
    refresh_token: String,
    access_token: Option<(String, Instant)>,
    label_ids: std::collections::HashMap<String, String>, // name -> id
}

impl GmailSession {
    /// Rebuild a session from keychain material (None if not connected).
    pub fn from_keychain(email: String) -> Option<Self> {
        let refresh_token = secrets::get(&secrets::gmail_refresh_entry(&email))
            .or_else(|| secrets::get(secrets::GMAIL_REFRESH_TOKEN_LEGACY))?;
        Some(Self {
            email,
            client_id: secrets::get(secrets::GMAIL_CLIENT_ID)?,
            client_secret: secrets::get(secrets::GMAIL_CLIENT_SECRET)?,
            refresh_token,
            access_token: None,
            label_ids: Default::default(),
        })
    }

    pub fn new_connected(email: String, access_token: String, expires_in: i64) -> Option<Self> {
        let refresh_token = secrets::get(&secrets::gmail_refresh_entry(&email))?;
        Some(Self {
            email,
            client_id: secrets::get(secrets::GMAIL_CLIENT_ID)?,
            client_secret: secrets::get(secrets::GMAIL_CLIENT_SECRET)?,
            refresh_token,
            access_token: Some((
                access_token,
                Instant::now() + Duration::from_secs(expires_in.max(60) as u64 - 60),
            )),
            label_ids: Default::default(),
        })
    }

    /// Resolve a label name to its Gmail id, creating the label if needed.
    /// System labels (INBOX, UNREAD, STARRED, IMPORTANT) are their own ids.
    pub async fn ensure_label_id(
        &mut self,
        http: &reqwest::Client,
        name: &str,
    ) -> Result<String, String> {
        if name.chars().all(|c| c.is_ascii_uppercase() || c == '_') {
            return Ok(name.to_string());
        }
        if self.label_ids.is_empty() {
            let v = self.get_json(http, &format!("{BASE}/labels")).await?;
            if let Some(arr) = v["labels"].as_array() {
                for l in arr {
                    if let (Some(n), Some(id)) = (l["name"].as_str(), l["id"].as_str()) {
                        self.label_ids.insert(n.to_string(), id.to_string());
                    }
                }
            }
        }
        if let Some(id) = self.label_ids.get(name) {
            return Ok(id.clone());
        }
        let v = self
            .post_json(
                http,
                &format!("{BASE}/labels"),
                json!({ "name": name, "labelListVisibility": "labelShow", "messageListVisibility": "show" }),
            )
            .await?;
        let id = v["id"].as_str().ok_or("label create returned no id")?.to_string();
        self.label_ids.insert(name.to_string(), id.clone());
        Ok(id)
    }

    async fn token(&mut self, http: &reqwest::Client) -> Result<String, String> {
        if let Some((tok, until)) = &self.access_token {
            if Instant::now() < *until {
                return Ok(tok.clone());
            }
        }
        let (tok, expires_in) = oauth::refresh_access_token(
            http,
            &self.client_id,
            &self.client_secret,
            &self.refresh_token,
        )
        .await?;
        self.access_token = Some((
            tok.clone(),
            Instant::now() + Duration::from_secs(expires_in.max(60) as u64 - 60),
        ));
        Ok(tok)
    }

    async fn get_json(&mut self, http: &reqwest::Client, url: &str) -> Result<Value, String> {
        let tok = self.token(http).await?;
        for attempt in 0..3u32 {
            let resp = http
                .get(url)
                .bearer_auth(&tok)
                .send()
                .await
                .map_err(|_| "Gmail request failed (network)".to_string())?;
            let status = resp.status();
            if status.as_u16() == 429 || status.as_u16() >= 500 {
                tokio::time::sleep(Duration::from_millis(500 * 2u64.pow(attempt))).await;
                continue;
            }
            if !status.is_success() {
                return Err(format!("Gmail API error ({status})"));
            }
            return resp
                .json()
                .await
                .map_err(|_| "Gmail returned an unexpected response".to_string());
        }
        Err("Gmail API rate-limited; try again shortly".to_string())
    }

    async fn post_json(
        &mut self,
        http: &reqwest::Client,
        url: &str,
        body: Value,
    ) -> Result<Value, String> {
        let tok = self.token(http).await?;
        for attempt in 0..3u32 {
            let resp = http
                .post(url)
                .bearer_auth(&tok)
                .json(&body)
                .send()
                .await
                .map_err(|_| "Gmail request failed (network)".to_string())?;
            let status = resp.status();
            if status.as_u16() == 429 || status.as_u16() >= 500 {
                tokio::time::sleep(Duration::from_millis(500 * 2u64.pow(attempt))).await;
                continue;
            }
            if !status.is_success() {
                return Err(format!("Gmail API error ({status})"));
            }
            return resp
                .json()
                .await
                .map_err(|_| "Gmail returned an unexpected response".to_string());
        }
        Err("Gmail API rate-limited; try again shortly".to_string())
    }

    pub async fn profile_email(http: &reqwest::Client, access_token: &str) -> Result<String, String> {
        let resp = http
            .get(format!("{BASE}/profile"))
            .bearer_auth(access_token)
            .send()
            .await
            .map_err(|_| "could not fetch the Gmail profile".to_string())?;
        if !resp.status().is_success() {
            return Err(format!("Gmail profile error ({})", resp.status()));
        }
        let v: Value = resp.json().await.map_err(|e| e.to_string())?;
        v["emailAddress"]
            .as_str()
            .map(str::to_string)
            .ok_or("profile had no email".to_string())
    }

    /// (thread_id, history_id) pairs for a query.
    pub async fn list_thread_ids(
        &mut self,
        http: &reqwest::Client,
        query: &str,
        max: u32,
    ) -> Result<Vec<(String, String)>, String> {
        let url = format!(
            "{BASE}/threads?maxResults={max}&q={}",
            url::form_urlencoded::byte_serialize(query.as_bytes()).collect::<String>()
        );
        let v = self.get_json(http, &url).await?;
        Ok(v["threads"]
            .as_array()
            .map(|a| {
                a.iter()
                    .filter_map(|t| {
                        Some((
                            t["id"].as_str()?.to_string(),
                            t["historyId"].as_str().unwrap_or_default().to_string(),
                        ))
                    })
                    .collect()
            })
            .unwrap_or_default())
    }

    pub async fn get_thread_full(
        &mut self,
        http: &reqwest::Client,
        id: &str,
    ) -> Result<Value, String> {
        self.get_json(http, &format!("{BASE}/threads/{id}?format=full")).await
    }

    pub async fn modify_thread(
        &mut self,
        http: &reqwest::Client,
        id: &str,
        add: &[&str],
        remove: &[&str],
    ) -> Result<(), String> {
        self.post_json(
            http,
            &format!("{BASE}/threads/{id}/modify"),
            json!({ "addLabelIds": add, "removeLabelIds": remove }),
        )
        .await
        .map(|_| ())
    }

    /// Move a thread to Gmail's Trash (recoverable server-side for 30 days).
    pub async fn trash_thread(&mut self, http: &reqwest::Client, id: &str) -> Result<(), String> {
        self.post_json(http, &format!("{BASE}/threads/{id}/trash"), json!({}))
            .await
            .map(|_| ())
    }

    pub async fn send(
        &mut self,
        http: &reqwest::Client,
        raw_rfc822: &str,
        thread_id: Option<&str>,
    ) -> Result<(), String> {
        let raw = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(raw_rfc822.as_bytes());
        let mut body = json!({ "raw": raw });
        if let Some(tid) = thread_id {
            body["threadId"] = json!(tid);
        }
        self.post_json(http, &format!("{BASE}/messages/send"), body)
            .await
            .map(|_| ())
    }

    pub async fn get_attachment_bytes(
        &mut self,
        http: &reqwest::Client,
        message_id: &str,
        attachment_id: &str,
    ) -> Result<Vec<u8>, String> {
        let v = self
            .get_json(
                http,
                &format!("{BASE}/messages/{message_id}/attachments/{attachment_id}"),
            )
            .await?;
        let data = v["data"].as_str().ok_or("attachment had no data")?;
        base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(data)
            .map_err(|_| "attachment data was not valid base64".to_string())
    }

}

// ------------------------------------------------------------- MIME parsing

pub struct ParsedMessage {
    pub message: Message,
    pub rfc_message_id: Option<String>,
    pub attachments: Vec<(Attachment, Option<String>)>, // (meta, gmail attachment id)
    pub label_ids: Vec<String>,
}

fn header<'a>(payload: &'a Value, name: &str) -> Option<&'a str> {
    payload["headers"].as_array()?.iter().find_map(|h| {
        if h["name"].as_str()?.eq_ignore_ascii_case(name) {
            h["value"].as_str()
        } else {
            None
        }
    })
}

fn parse_address(raw: &str) -> (String, String) {
    // "Name <addr>" | "addr"
    if let Some(start) = raw.find('<') {
        let name = raw[..start].trim().trim_matches('"').to_string();
        let addr = raw[start + 1..].trim_end_matches('>').trim().to_string();
        let name = if name.is_empty() { addr.clone() } else { name };
        (name, addr)
    } else {
        (raw.trim().to_string(), raw.trim().to_string())
    }
}

fn split_addresses(raw: &str) -> Vec<String> {
    raw.split(',')
        .map(|s| parse_address(s).1)
        .filter(|s| !s.is_empty())
        .collect()
}

fn decode_body(part: &Value) -> Option<String> {
    let data = part["body"]["data"].as_str()?;
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(data)
        .ok()?;
    Some(String::from_utf8_lossy(&bytes).to_string())
}

/// Crude but dependable HTML→text for the reading pane fallback.
pub fn strip_html(html: &str) -> String {
    let mut out = String::with_capacity(html.len() / 2);
    let mut in_tag = false;
    let mut in_style_or_script = false;
    let lower = html.to_ascii_lowercase();
    for (i, c) in html.char_indices() {
        let rest = &lower[i..]; // char_indices of the ASCII-lowered twin align byte-for-byte
        if !in_tag && (rest.starts_with("<style") || rest.starts_with("<script")) {
            in_style_or_script = true;
        }
        if in_style_or_script && (rest.starts_with("</style>") || rest.starts_with("</script>")) {
            in_style_or_script = false;
        }
        if c == '<' {
            in_tag = true;
            if rest.starts_with("<br") || rest.starts_with("<p") || rest.starts_with("<div") {
                out.push('\n');
            }
        } else if c == '>' {
            in_tag = false;
        } else if !in_tag && !in_style_or_script {
            out.push(c);
        }
    }
    let out = out
        .replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'");
    // collapse blank-line runs
    let mut result = String::with_capacity(out.len());
    let mut blank = 0;
    for line in out.lines() {
        let t = line.trim();
        if t.is_empty() {
            blank += 1;
            if blank <= 1 {
                result.push('\n');
            }
        } else {
            blank = 0;
            result.push_str(t);
            result.push('\n');
        }
    }
    result.trim().to_string()
}

fn walk_parts(
    part: &Value,
    text: &mut Option<String>,
    html: &mut Option<String>,
    atts: &mut Vec<(String, String, i64, String)>, // filename, mime, size, attachment_id
) {
    let mime = part["mimeType"].as_str().unwrap_or_default();
    let filename = part["filename"].as_str().unwrap_or_default();
    if !filename.is_empty() {
        if let Some(att_id) = part["body"]["attachmentId"].as_str() {
            atts.push((
                filename.to_string(),
                mime.to_string(),
                part["body"]["size"].as_i64().unwrap_or(0),
                att_id.to_string(),
            ));
        }
    } else if mime == "text/plain" && text.is_none() {
        *text = decode_body(part);
    } else if mime == "text/html" && html.is_none() {
        *html = decode_body(part);
    }
    if let Some(children) = part["parts"].as_array() {
        for child in children {
            walk_parts(child, text, html, atts);
        }
    }
}

pub fn parse_gmail_message(msg: &Value, thread_id: &str) -> ParsedMessage {
    let payload = &msg["payload"];
    let id = msg["id"].as_str().unwrap_or_default().to_string();
    let label_ids: Vec<String> = msg["labelIds"]
        .as_array()
        .map(|a| a.iter().filter_map(|l| l.as_str().map(str::to_string)).collect())
        .unwrap_or_default();

    let (from_name, from_addr) = parse_address(header(payload, "From").unwrap_or_default());
    let to = split_addresses(header(payload, "To").unwrap_or_default());
    let cc = split_addresses(header(payload, "Cc").unwrap_or_default());
    let subject = header(payload, "Subject").unwrap_or_default().to_string();
    let rfc_message_id = header(payload, "Message-ID")
        .or_else(|| header(payload, "Message-Id"))
        .map(str::to_string);
    let date = msg["internalDate"]
        .as_str()
        .and_then(|s| s.parse::<i64>().ok())
        .unwrap_or(0);

    let mut text = None;
    let mut html = None;
    let mut raw_atts = vec![];
    walk_parts(payload, &mut text, &mut html, &mut raw_atts);
    let body_text = text
        .clone()
        .or_else(|| html.as_deref().map(strip_html))
        .unwrap_or_default();

    let attachments = raw_atts
        .into_iter()
        .enumerate()
        .map(|(i, (filename, mime, size, att_id))| {
            (
                Attachment {
                    id: format!("{id}-a{}", i + 1),
                    message_id: id.clone(),
                    filename,
                    mime_type: mime,
                    size_bytes: size,
                },
                Some(att_id),
            )
        })
        .collect();

    ParsedMessage {
        message: Message {
            id: id.clone(),
            thread_id: thread_id.to_string(),
            from: from_addr,
            from_name,
            to,
            cc,
            subject,
            snippet: msg["snippet"].as_str().unwrap_or_default().to_string(),
            body_text,
            body_html: html,
            date,
            unread: label_ids.iter().any(|l| l == "UNREAD"),
            attachments: vec![],
        },
        rfc_message_id,
        attachments,
        label_ids,
    }
}

/// Build the outgoing RFC 822 message for messages.send.
pub fn build_rfc822(
    from: &str,
    mail: &OutgoingMail,
    in_reply_to: Option<&str>,
) -> String {
    let date = chrono::Utc::now().format("%a, %d %b %Y %H:%M:%S +0000");
    let mut headers = vec![
        format!("From: {from}"),
        format!("To: {}", mail.to.join(", ")),
    ];
    if !mail.cc.is_empty() {
        headers.push(format!("Cc: {}", mail.cc.join(", ")));
    }
    headers.push(format!("Subject: {}", mail.subject.replace(['\r', '\n'], " ")));
    headers.push(format!("Date: {date}"));
    if let Some(irt) = in_reply_to {
        headers.push(format!("In-Reply-To: {irt}"));
        headers.push(format!("References: {irt}"));
    }
    headers.push("MIME-Version: 1.0".to_string());
    headers.push("Content-Type: text/plain; charset=UTF-8".to_string());
    headers.push("Content-Transfer-Encoding: 8bit".to_string());
    format!("{}\r\n\r\n{}", headers.join("\r\n"), mail.body_text)
}
