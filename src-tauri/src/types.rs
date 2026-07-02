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
}

fn default_theme() -> String {
    "dark".into()
}

fn default_true() -> bool {
    true
}

/// Connected-account profile shown in the header (photo is a data: URI).
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct ProfileInfo {
    pub name: String,
    pub picture: Option<String>,
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
