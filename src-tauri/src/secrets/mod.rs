//! OS-keychain storage (Windows Credential Manager via the `keyring` crate).
//! Every secret ZenBox holds lives here: AI keys and Gmail OAuth material.
//! Values never appear in logs, errors, or the SQLite file.

const SERVICE: &str = "ZenBoxMail";

pub const AI_CLAUDE: &str = "ai:claude";
pub const AI_OPENAI: &str = "ai:openai";
pub const AI_NIM: &str = "ai:nim";
pub const GMAIL_CLIENT_ID: &str = "gmail:client_id";
pub const GMAIL_CLIENT_SECRET: &str = "gmail:client_secret";
/// v0.1 single-account name; kept as a read fallback.
pub const GMAIL_REFRESH_TOKEN_LEGACY: &str = "gmail:refresh_token";

pub fn gmail_refresh_entry(email: &str) -> String {
    format!("gmail:refresh_token:{email}")
}

pub fn ai_key_entry(provider: &str) -> Option<&'static str> {
    match provider {
        "claude" => Some(AI_CLAUDE),
        "openai" => Some(AI_OPENAI),
        "nim" => Some(AI_NIM),
        _ => None,
    }
}

fn entry(name: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, name).map_err(|_| "keychain unavailable".to_string())
}

pub fn set(name: &str, value: &str) -> Result<(), String> {
    entry(name)?
        .set_password(value)
        .map_err(|_| "could not write to the OS keychain".to_string())
}

pub fn get(name: &str) -> Option<String> {
    entry(name).ok()?.get_password().ok()
}

pub fn delete(name: &str) {
    if let Ok(e) = entry(name) {
        let _ = e.delete_credential();
    }
}
