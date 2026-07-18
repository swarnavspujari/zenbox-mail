//! OS-keychain storage (Windows Credential Manager via the `keyring` crate).
//! Every secret Snail Mail holds lives here: AI keys and Gmail OAuth material.
//! Values never appear in logs, errors, or the SQLite file.

const SERVICE: &str = "SnailMail";
/// Pre-rename service names, newest first. Secrets are read from these as a
/// fallback and copied forward on first access, so installs from any earlier
/// brand keep their tokens + AI keys.
const LEGACY_SERVICES: [&str; 2] = ["FissionMail", "ZenBoxMail"];

pub const AI_CLAUDE: &str = "ai:claude";
pub const AI_OPENAI: &str = "ai:openai";
pub const AI_NIM: &str = "ai:nim";
pub const GMAIL_CLIENT_ID: &str = "gmail:client_id";
pub const GMAIL_CLIENT_SECRET: &str = "gmail:client_secret";
/// BYO Unsplash Access Key — overrides the baked one when present.
pub const UNSPLASH_ACCESS_KEY: &str = "unsplash:access_key";
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
    chain_get(SERVICE, &LEGACY_SERVICES, name)
}

pub fn delete(name: &str) {
    chain_delete(SERVICE, &LEGACY_SERVICES, name);
}

/// Delete `name` from the primary AND every legacy service. Deleting only the
/// primary is not enough: chain_get's copy-forward would resurrect a
/// surviving legacy copy on the next read — observed post-rebrand, where
/// disconnect deleted the SnailMail token entry and the (revoked) FissionMail
/// copy kept coming back as a permanently-failing session.
fn chain_delete(primary: &str, legacy: &[&str], name: &str) {
    for svc in std::iter::once(primary).chain(legacy.iter().copied()) {
        if let Ok(e) = keyring::Entry::new(svc, name) {
            let _ = e.delete_credential();
        }
    }
}

/// Read `name` from `primary`, else from each legacy service in order; a
/// legacy hit is copied forward to `primary` so the next read is direct.
fn chain_get(primary: &str, legacy: &[&str], name: &str) -> Option<String> {
    if let Ok(e) = keyring::Entry::new(primary, name) {
        if let Ok(v) = e.get_password() {
            return Some(v);
        }
    }
    for svc in legacy {
        if let Ok(old) = keyring::Entry::new(svc, name) {
            if let Ok(v) = old.get_password() {
                if let Ok(e) = keyring::Entry::new(primary, name) {
                    let _ = e.set_password(&v);
                }
                return Some(v);
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::{chain_delete, chain_get};

    /// Real OS-keychain entries under throwaway service names, wiped before
    /// and after each test so nothing lingers in Credential Manager.
    struct Scratch(&'static [&'static str], &'static str);
    impl Scratch {
        fn new(services: &'static [&'static str], name: &'static str) -> Self {
            let s = Scratch(services, name);
            s.wipe();
            s
        }
        fn wipe(&self) {
            for svc in self.0 {
                if let Ok(e) = keyring::Entry::new(svc, self.1) {
                    let _ = e.delete_credential();
                }
            }
        }
        fn set(&self, svc: &str, value: &str) {
            keyring::Entry::new(svc, self.1).unwrap().set_password(value).unwrap();
        }
        fn get(&self, svc: &str) -> Option<String> {
            keyring::Entry::new(svc, self.1).ok()?.get_password().ok()
        }
    }
    impl Drop for Scratch {
        fn drop(&mut self) {
            self.wipe();
        }
    }

    const NEW: &str = "SnailHopTestNew";
    const MID: &str = "SnailHopTestMid";
    const OLD: &str = "SnailHopTestOld";

    #[test]
    fn primary_wins_when_present_everywhere() {
        let s = Scratch::new(&[NEW, MID, OLD], "t:primary");
        s.set(NEW, "new-v");
        s.set(MID, "mid-v");
        assert_eq!(chain_get(NEW, &[MID, OLD], "t:primary").as_deref(), Some("new-v"));
    }

    #[test]
    fn legacy_hit_is_returned_and_copied_forward() {
        let s = Scratch::new(&[NEW, MID, OLD], "t:copy-fwd");
        s.set(OLD, "old-v");
        assert_eq!(chain_get(NEW, &[MID, OLD], "t:copy-fwd").as_deref(), Some("old-v"));
        // migrated: the next read finds it under the primary service
        assert_eq!(s.get(NEW).as_deref(), Some("old-v"));
    }

    #[test]
    fn newer_legacy_service_wins_over_older() {
        let s = Scratch::new(&[NEW, MID, OLD], "t:order");
        s.set(MID, "mid-v");
        s.set(OLD, "old-v");
        assert_eq!(chain_get(NEW, &[MID, OLD], "t:order").as_deref(), Some("mid-v"));
    }

    #[test]
    fn absent_everywhere_is_none() {
        let _s = Scratch::new(&[NEW, MID, OLD], "t:absent");
        assert_eq!(chain_get(NEW, &[MID, OLD], "t:absent"), None);
    }

    #[test]
    fn delete_removes_every_service_copy_so_nothing_resurrects() {
        let s = Scratch::new(&[NEW, MID, OLD], "t:del-all");
        s.set(NEW, "new-v");
        s.set(MID, "mid-v");
        s.set(OLD, "old-v");
        chain_delete(NEW, &[MID, OLD], "t:del-all");
        assert_eq!(s.get(NEW), None);
        assert_eq!(s.get(MID), None);
        assert_eq!(s.get(OLD), None);
        // and a chained read can no longer copy anything forward
        assert_eq!(chain_get(NEW, &[MID, OLD], "t:del-all"), None);
    }
}
