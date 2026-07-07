//! Domain types crossing the IPC boundary. Field names serialize to
//! camelCase to match src/lib/types.ts exactly.
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Attachment {
    pub id: String,
    pub message_id: String,
    pub filename: String,
    pub mime_type: String,
    pub size_bytes: i64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Message {
    pub id: String,
    pub thread_id: String,
    pub from: String,
    pub from_name: String,
    pub to: Vec<String>,
    pub cc: Vec<String>,
    pub subject: String,
    pub snippet: String,
    pub body_text: String,
    pub body_html: Option<String>,
    pub date: i64,
    pub unread: bool,
    pub attachments: Vec<Attachment>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Thread {
    pub id: String,
    pub subject: String,
    pub snippet: String,
    pub participants: Vec<String>,
    pub message_count: i64,
    pub last_date: i64,
    pub unread: bool,
    pub starred: bool,
    pub labels: Vec<String>,
    pub in_inbox: bool,
    pub snoozed_until: Option<i64>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SplitRule {
    pub field: String, // from | to | subject | label
    pub contains: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Split {
    pub id: String,
    pub name: String,
    pub builtin: bool,
    pub rules: Vec<SplitRule>,
    pub op: String, // and | or
    pub hide_when_empty: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AiProviderConfig {
    pub id: String, // claude | openai | nim
    pub label: String,
    pub model: String,
    pub base_url: Option<String>,
    pub has_key: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub splits: Vec<Split>,
    pub default_ai_provider: String,
    pub providers: Vec<AiProviderConfig>,
    pub celebration_dir: Option<String>,
    pub shortcuts: std::collections::HashMap<String, String>,
    /// account email -> signature text, appended to outgoing mail
    #[serde(default)]
    pub signatures: std::collections::HashMap<String, String>,
    /// "dark" (default) or "light"
    #[serde(default = "default_theme")]
    pub theme: String,
    /// Desktop notifications for new mail (while the window is unfocused).
    #[serde(default = "default_true")]
    pub notifications: bool,
    /// Onboarding completed — the welcome flow shows until this flips.
    #[serde(default)]
    pub onboarded: bool,
    /// Calendar side panel visible.
    #[serde(default)]
    pub calendar_open: bool,
    /// Folder/label sidebar visible.
    #[serde(default)]
    pub sidebar_open: bool,
    /// Bottom shortcut-hint footer visible (default true, incl. older state).
    #[serde(default = "default_true")]
    pub show_shortcut_bar: bool,
    /// Undo Send window in seconds (0 = off / send immediately). Default 10.
    #[serde(default = "default_undo_send")]
    pub undo_send_seconds: i64,
    /// Oversized attachments → Drive links: "ask" (confirm per drop) or
    /// "always" (upload without asking).
    #[serde(default = "default_drive_auto_upload")]
    pub drive_auto_upload: String,
    /// Remembered share-on-send choice: "recipients" | "anyone" | "none".
    #[serde(default = "default_drive_share_mode")]
    pub drive_share_mode: String,
}

fn default_theme() -> String {
    "dark".into()
}

fn default_true() -> bool {
    true
}

fn default_undo_send() -> i64 {
    10
}

fn default_drive_auto_upload() -> String {
    "ask".into()
}

fn default_drive_share_mode() -> String {
    "recipients".into()
}

/// Which Google features this account's OAuth grant actually covers.
/// Users can uncheck scopes on the consent screen, and accounts connected
/// before v0.15 hold tokens that predate the new scopes entirely — every
/// feature gates on this instead of assuming the full block was granted.
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Capabilities {
    /// Google Drive (attach from Drive, oversized→Drive-link, share-on-send).
    pub drive: bool,
    /// People API contacts (saved and/or "other" contacts autocomplete).
    pub contacts: bool,
    /// Full calendar scope (event CRUD) vs the old calendar.readonly.
    pub calendar_write: bool,
    /// gmail.settings.basic (send-as aliases).
    pub settings_read: bool,
    /// Connected before grant tracking existed — needs one reconnect to
    /// grant (and record) the new scopes.
    pub legacy_grant: bool,
}

/// One Gmail send-as alias (users.settings.sendAs, read-only surface).
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SendAsAlias {
    pub email: String,
    pub display_name: String,
    /// The alias Gmail uses by default for new mail.
    pub is_default: bool,
    /// Primary address, or a verified alias (Gmail refuses unverified Froms).
    pub verified: bool,
    /// The alias has its own Gmail-side signature configured.
    pub has_signature: bool,
}

/// Connected-account profile shown in the header (photo is a data: URI).
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct ProfileInfo {
    pub name: String,
    pub picture: Option<String>,
}

/// A person the account has corresponded with — recipient autocomplete.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Contact {
    pub name: String,
    pub email: String,
}

/// Daily Unsplash photo for empty rest states. Attribution links arrive
/// pre-tagged with the referral utm params; the UI hotlinks `url` and falls
/// back to `cached_data_uri` offline.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DailyPhoto {
    pub url: String,
    pub blur_hash: Option<String>,
    pub author_name: String,
    pub author_link: Option<String>,
    pub photo_link: Option<String>,
    pub download_location: Option<String>,
    pub cached_data_uri: Option<String>,
    pub fetched_at: i64,
}

/// One event in the calendar side panel.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CalendarEvent {
    pub id: String,
    pub calendar: String,
    pub color: Option<String>,
    pub title: String,
    pub start_ms: i64,
    pub end_ms: i64,
    pub all_day: bool,
    pub location: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct UnsubResult {
    pub kind: String, // opened | mailto | none
    pub target: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct KbItem {
    pub id: String,
    pub title: String,
    pub body: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeBase {
    pub instructions: String,
    pub snippets: Vec<KbItem>,
    pub voice_examples: Vec<KbItem>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Streaks {
    pub daily: i64,
    pub weekly: i64,
    pub last_zero_day: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AccountInfo {
    pub email: String,
    pub provider: String, // gmail | outlook | mock
    pub connected: bool,
}

/// All connected accounts, in slot order (index 0 = Ctrl+1), plus the active one.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AccountsState {
    pub accounts: Vec<AccountInfo>,
    pub active: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DraftRequest {
    pub thread_id: Option<String>,
    pub instruction: String,
    pub existing_text: Option<String>,
    pub provider_id: Option<String>,
}

/// One Google Drive file (picker rows, link chips, upload results).
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DriveFile {
    pub id: String,
    pub name: String,
    pub mime_type: String,
    pub size: Option<i64>,
    pub web_view_link: String,
    pub icon_link: Option<String>,
    pub modified_time: Option<String>,
    pub owner: Option<String>,
}

/// One page of Drive search results.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DriveSearchPage {
    pub files: Vec<DriveFile>,
    pub next_page_token: Option<String>,
}

/// Outcome of one uploaded chunk: not done yet, or the finished file.
/// `next_offset` is the server-acknowledged high-water mark — the webview
/// slices the next chunk from here (Drive may persist less than was sent).
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DriveChunkResult {
    pub done: bool,
    pub file: Option<DriveFile>,
    pub next_offset: i64,
}

/// A file attached to an outgoing message (bytes travel base64 over IPC and
/// sit in the outbox payload so scheduled sends survive restarts).
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MailAttachment {
    pub filename: String,
    pub mime_type: String,
    pub data_base64: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct OutgoingMail {
    pub thread_id: Option<String>,
    pub to: Vec<String>,
    pub cc: Vec<String>,
    #[serde(default)]
    pub bcc: Vec<String>,
    pub subject: String,
    pub body_text: String,
    /// HTML alternative (signatures with images); None = plain text only.
    #[serde(default)]
    pub body_html: Option<String>,
    pub reply_all: bool,
    #[serde(default)]
    pub attachments: Vec<MailAttachment>,
}

/// A locally persisted, unsent compose draft. `payload` is the frontend's
/// compose state as opaque JSON — the core only stores and lists it.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DraftEntry {
    pub id: i64,
    pub payload: String,
    pub updated_at: i64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    pub thread_id: String,
    pub subject: String,
    pub snippet: String,
    pub last_date: i64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ZeroEvent {
    pub split_id: String,
    pub daily: i64,
    pub weekly: i64,
    pub image_path: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct BulkArchiveOpts {
    pub split_id: Option<String>,
    pub older_than_days: i64,
    pub preserve_unread: bool,
    pub preserve_starred: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TestResult {
    pub ok: bool,
    pub message: String,
}
