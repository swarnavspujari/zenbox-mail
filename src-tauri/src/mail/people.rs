//! Google People API → recipient autocomplete: saved contacts, "other
//! contacts" (people you've emailed), and the Workspace directory. Rides the
//! account's Gmail OAuth session (contacts.* scopes, v0.15+). Read-only.
//!
//! Sources degrade independently: a 403 on one (scope unchecked at consent,
//! or a consumer account's nonexistent directory) skips that source without
//! touching the others — and without wiping its previously synced rows.
use crate::mail::gmail::GmailSession;
use serde_json::Value;

const BASE: &str = "https://people.googleapis.com/v1";
/// Pagination safety cap per source (pageSize is 1000, so ≤5 pages).
const MAX_PER_SOURCE: usize = 5000;

/// One (email, name) pair from one source; a person with three addresses
/// becomes three rows.
pub struct PersonRow {
    pub email: String,
    pub name: String,
    pub photo_url: Option<String>,
}

fn classify(e: &str) -> String {
    crate::mail::classify_google_error(e, "People API", "Contacts")
}

/// Flatten one page of person objects into rows.
fn collect(page: &Value, list_key: &str, out: &mut Vec<PersonRow>) {
    let empty = vec![];
    for p in page[list_key].as_array().unwrap_or(&empty) {
        let name = p["names"][0]["displayName"].as_str().unwrap_or("").trim().to_string();
        let photo = p["photos"][0]["url"].as_str().map(str::to_string);
        for e in p["emailAddresses"].as_array().unwrap_or(&empty) {
            let Some(addr) = e["value"].as_str() else { continue };
            let addr = addr.trim().to_lowercase();
            if addr.contains('@') && addr.len() <= 254 {
                out.push(PersonRow {
                    email: addr,
                    name: name.clone(),
                    photo_url: photo.clone(),
                });
            }
        }
    }
}

/// Paginate one People endpoint to completion (or the safety cap).
async fn fetch_paged(
    http: &reqwest::Client,
    session: &mut GmailSession,
    base_url: &str,
    list_key: &str,
) -> Result<Vec<PersonRow>, String> {
    let mut out = vec![];
    let mut page_token: Option<String> = None;
    loop {
        let mut url = base_url.to_string();
        if let Some(t) = &page_token {
            url.push_str(&format!(
                "&pageToken={}",
                url::form_urlencoded::byte_serialize(t.as_bytes()).collect::<String>()
            ));
        }
        let v = session.get_json(http, &url).await.map_err(|e| classify(&e))?;
        collect(&v, list_key, &mut out);
        page_token = v["nextPageToken"].as_str().map(str::to_string);
        if page_token.is_none() || out.len() >= MAX_PER_SOURCE {
            break;
        }
    }
    out.truncate(MAX_PER_SOURCE);
    Ok(out)
}

/// Saved contacts (connections.list — uses personFields).
pub async fn fetch_contacts(
    http: &reqwest::Client,
    session: &mut GmailSession,
) -> Result<Vec<PersonRow>, String> {
    fetch_paged(
        http,
        session,
        &format!("{BASE}/people/me/connections?personFields=names,emailAddresses,photos&pageSize=1000"),
        "connections",
    )
    .await
}

/// "Other contacts" — people interacted with but never saved (uses readMask).
pub async fn fetch_other_contacts(
    http: &reqwest::Client,
    session: &mut GmailSession,
) -> Result<Vec<PersonRow>, String> {
    fetch_paged(
        http,
        session,
        &format!("{BASE}/otherContacts?readMask=names,emailAddresses,photos&pageSize=1000"),
        "otherContacts",
    )
    .await
}

/// Workspace directory (profiles + domain shared contacts). Consumer accounts
/// have none — callers treat an error here as "skip this source".
pub async fn fetch_directory(
    http: &reqwest::Client,
    session: &mut GmailSession,
) -> Result<Vec<PersonRow>, String> {
    fetch_paged(
        http,
        session,
        &format!(
            "{BASE}/people:listDirectoryPeople?readMask=names,emailAddresses&pageSize=1000\
             &sources=DIRECTORY_SOURCE_TYPE_DOMAIN_PROFILE&sources=DIRECTORY_SOURCE_TYPE_DOMAIN_CONTACT"
        ),
        "people",
    )
    .await
}
