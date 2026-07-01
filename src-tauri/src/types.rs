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

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct OutgoingMail {
    pub thread_id: Option<String>,
    pub to: Vec<String>,
    pub cc: Vec<String>,
    pub subject: String,
    pub body_text: String,
    pub reply_all: bool,
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
