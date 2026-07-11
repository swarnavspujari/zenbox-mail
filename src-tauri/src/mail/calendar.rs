//! Google Calendar for the side panel / week view. Rides the account's Gmail
//! OAuth session — the full calendar scope is requested at connect time.
use crate::mail::gmail::GmailSession;
use crate::types::{CalendarEvent, EventAttendee};
use serde_json::Value;

const BASE: &str = "https://www.googleapis.com/calendar/v3";
const MAX_CALENDARS: usize = 25;

/// One entry from the user's calendarList — the per-calendar context every
/// parsed event carries.
#[derive(Clone, Debug)]
pub struct CalMeta {
    pub id: String,
    pub name: String,
    pub color: Option<String>,
    /// owner | writer | reader | freeBusyReader
    pub access_role: String,
    /// The account's primary calendar (default target for new events).
    pub primary: bool,
}

/// The user's visible calendars (selected in Google Calendar), capped.
pub async fn list_calendars(
    http: &reqwest::Client,
    session: &mut GmailSession,
) -> Result<Vec<CalMeta>, String> {
    let cal_list = session
        .get_json(http, &format!("{BASE}/users/me/calendarList?maxResults=100"))
        .await
        .map_err(|e| classify_calendar_error(&e))?;
    let empty = vec![];
    let mut cals: Vec<CalMeta> = cal_list["items"]
        .as_array()
        .unwrap_or(&empty)
        .iter()
        .filter(|c| c["selected"].as_bool().unwrap_or(true))
        .filter_map(|c| {
            Some(CalMeta {
                id: c["id"].as_str()?.to_string(),
                name: c["summary"].as_str().unwrap_or("Calendar").to_string(),
                color: c["backgroundColor"].as_str().map(str::to_string),
                access_role: c["accessRole"].as_str().unwrap_or("reader").to_string(),
                primary: c["primary"].as_bool().unwrap_or(false),
            })
        })
        .collect();
    // If the cap ever bites, keep the calendars the user can act on: primary
    // first, then by privilege — never silently drop the primary calendar.
    cals.sort_by_key(|c| {
        (!c.primary, match c.access_role.as_str() {
            "owner" => 0u8,
            "writer" => 1,
            "reader" => 2,
            _ => 3,
        })
    });
    cals.truncate(MAX_CALENDARS);
    Ok(cals)
}

/// One Google event item → our model. None for items without a start (and
/// for cancelled sync tombstones, which carry no times — callers handle
/// status=cancelled before parsing where deletion matters).
pub fn parse_event(item: &Value, cal: &CalMeta) -> Option<CalendarEvent> {
    let (start, all_day) = event_time(&item["start"])?;
    let end = event_time(&item["end"]).map(|(t, _)| t).unwrap_or(start);
    let empty = vec![];
    let attendees: Vec<EventAttendee> = item["attendees"]
        .as_array()
        .unwrap_or(&empty)
        .iter()
        .filter_map(|a| {
            Some(EventAttendee {
                email: a["email"].as_str()?.to_string(),
                display_name: a["displayName"].as_str().map(str::to_string),
                optional: a["optional"].as_bool().unwrap_or(false),
                response_status: a["responseStatus"].as_str().unwrap_or("needsAction").to_string(),
                self_: a["self"].as_bool().unwrap_or(false),
                organizer: a["organizer"].as_bool().unwrap_or(false),
            })
        })
        .collect();
    Some(CalendarEvent {
        id: item["id"].as_str().unwrap_or_default().to_string(),
        calendar_id: cal.id.clone(),
        calendar: cal.name.clone(),
        color: cal.color.clone(),
        title: item["summary"].as_str().unwrap_or("(busy)").to_string(),
        start_ms: start,
        end_ms: end,
        all_day,
        location: item["location"].as_str().map(str::to_string),
        description: item["description"].as_str().map(str::to_string),
        html_link: item["htmlLink"].as_str().map(str::to_string),
        etag: item["etag"].as_str().map(str::to_string),
        status: item["status"].as_str().unwrap_or("confirmed").to_string(),
        organizer_email: item["organizer"]["email"].as_str().map(str::to_string),
        organizer_self: item["organizer"]["self"].as_bool().unwrap_or(false),
        recurring_event_id: item["recurringEventId"].as_str().map(str::to_string),
        hangout_link: item["hangoutLink"].as_str().map(str::to_string),
        attendees,
        access_role: cal.access_role.clone(),
        ical_uid: item["iCalUID"].as_str().map(str::to_string),
    })
}

/// One incremental pull's outcome: changed events to upsert, cancelled event
/// ids to drop, and the token for the next pull.
pub struct SyncDelta {
    pub upserts: Vec<CalendarEvent>,
    pub deleted_ids: Vec<String>,
    pub next_sync_token: String,
}

pub enum SyncError {
    /// 410 Gone — the stored syncToken expired; drop it and window-refetch.
    TokenExpired,
    Other(String),
}

fn enc(s: &str) -> String {
    url::form_urlencoded::byte_serialize(s.as_bytes()).collect()
}

/// GET with the shared backoff, returning the raw status + body so callers
/// can special-case 410/412.
async fn get_with_retry(
    http: &reqwest::Client,
    bearer: &str,
    url: &str,
) -> Result<(reqwest::StatusCode, String), String> {
    request_with_retry(http, reqwest::Method::GET, bearer, url, None, None).await
}

/// Shared error shaping: keep the body snippet (Google puts the actionable
/// reason there) and run it through the 403 classifier.
fn api_error(status: reqwest::StatusCode, body: &str) -> String {
    let snippet: String = body.chars().take(500).collect();
    classify_calendar_error(&format!("Calendar API error ({status}): {snippet}"))
}

const MAX_PAGES: usize = 40;

/// Incremental pull for one calendar with a stored syncToken. Only the
/// token-legal parameters ride along (orderBy/timeMin/timeMax/q are invalid
/// with syncToken); singleEvents matches the initial fetch, as required.
pub async fn sync_incremental(
    http: &reqwest::Client,
    bearer: &str,
    cal: &CalMeta,
    sync_token: &str,
) -> Result<SyncDelta, SyncError> {
    let mut upserts = vec![];
    let mut deleted_ids = vec![];
    let mut page_token: Option<String> = None;
    for _ in 0..MAX_PAGES {
        let mut url = format!(
            "{BASE}/calendars/{}/events?singleEvents=true&maxResults=250&syncToken={}",
            enc(&cal.id),
            enc(sync_token),
        );
        if let Some(pt) = &page_token {
            url.push_str(&format!("&pageToken={}", enc(pt)));
        }
        let (status, body) = get_with_retry(http, bearer, url.as_str())
            .await
            .map_err(SyncError::Other)?;
        if status.as_u16() == 410 {
            return Err(SyncError::TokenExpired);
        }
        if !status.is_success() {
            return Err(SyncError::Other(api_error(status, &body)));
        }
        let v: Value = serde_json::from_str(&body)
            .map_err(|_| SyncError::Other("Calendar returned an unexpected response".into()))?;
        collect_page(&v, cal, &mut upserts, &mut deleted_ids);
        match v["nextPageToken"].as_str() {
            Some(pt) => page_token = Some(pt.to_string()),
            None => {
                let next = v["nextSyncToken"].as_str().ok_or_else(|| {
                    SyncError::Other("Calendar sync response had no nextSyncToken".into())
                })?;
                return Ok(SyncDelta { upserts, deleted_ids, next_sync_token: next.to_string() });
            }
        }
    }
    // A delta larger than the page cap can't advance the token safely —
    // treat it like an expired token so the caller window-refetches.
    Err(SyncError::TokenExpired)
}

/// Full windowed fetch for one calendar (initial sync and 410 recovery):
/// expanded instances in [start_ms, end_ms), plus the nextSyncToken that
/// makes later pulls incremental.
pub async fn fetch_window(
    http: &reqwest::Client,
    bearer: &str,
    cal: &CalMeta,
    start_ms: i64,
    end_ms: i64,
) -> Result<(Vec<CalendarEvent>, Option<String>), String> {
    let mut events = vec![];
    let mut page_token: Option<String> = None;
    for _ in 0..MAX_PAGES {
        let mut url = format!(
            "{BASE}/calendars/{}/events?timeMin={}&timeMax={}&singleEvents=true&maxResults=250",
            enc(&cal.id),
            enc(&rfc3339(start_ms)),
            enc(&rfc3339(end_ms)),
        );
        if let Some(pt) = &page_token {
            url.push_str(&format!("&pageToken={}", enc(pt)));
        }
        let (status, body) = get_with_retry(http, bearer, url.as_str()).await?;
        if !status.is_success() {
            return Err(api_error(status, &body));
        }
        let v: Value =
            serde_json::from_str(&body).map_err(|_| "Calendar returned an unexpected response")?;
        let mut deleted = vec![];
        collect_page(&v, cal, &mut events, &mut deleted); // window fetch: tombstones just skipped
        match v["nextPageToken"].as_str() {
            Some(pt) => page_token = Some(pt.to_string()),
            None => {
                events.sort_by_key(|e| e.start_ms);
                return Ok((events, v["nextSyncToken"].as_str().map(str::to_string)));
            }
        }
    }
    // Over the page cap: keep what we have so the calendar still paints
    // (without a token — the next beat retries), instead of erroring forever.
    eprintln!("[calendar] {} exceeded the {MAX_PAGES}-page window cap; caching partial", cal.name);
    events.sort_by_key(|e| e.start_ms);
    Ok((events, None))
}

/// Split one events page into upserts and cancelled ids.
fn collect_page(
    v: &Value,
    cal: &CalMeta,
    upserts: &mut Vec<CalendarEvent>,
    deleted_ids: &mut Vec<String>,
) {
    let empty = vec![];
    for item in v["items"].as_array().unwrap_or(&empty) {
        if item["status"].as_str() == Some("cancelled") {
            if let Some(id) = item["id"].as_str() {
                deleted_ids.push(id.to_string());
            }
            continue;
        }
        if let Some(e) = parse_event(item, cal) {
            upserts.push(e);
        }
    }
}

/// Events on one calendar matching an RFC5545 UID (invite-mail resolution).
/// No singleEvents expansion — a recurring invite resolves to its series
/// master, so an RSVP covers the whole series like Gmail's own buttons.
pub async fn events_by_ical_uid(
    http: &reqwest::Client,
    bearer: &str,
    cal: &CalMeta,
    uid: &str,
) -> Result<Vec<CalendarEvent>, String> {
    let url = format!(
        "{BASE}/calendars/{}/events?iCalUID={}&maxResults=5",
        enc(&cal.id),
        enc(uid),
    );
    let (status, body) = get_with_retry(http, bearer, &url).await?;
    if !status.is_success() {
        return Err(api_error(status, &body));
    }
    let v: Value =
        serde_json::from_str(&body).map_err(|_| "Calendar returned an unexpected response")?;
    let mut events = vec![];
    let mut deleted = vec![];
    collect_page(&v, cal, &mut events, &mut deleted);
    Ok(events)
}

// ------------------------------------------------------------------ writes

/// Saved, or refused with the fresh server copy (If-Match mismatch → 412).
pub enum WriteOutcome {
    Saved(CalendarEvent),
    Conflict(CalendarEvent),
}

/// Request with 429/5xx backoff; `if_match` rides as the If-Match header for
/// etag-guarded update/delete. POST is NOT retried on 5xx — an events.insert
/// whose 500 response hid a committed write would duplicate the event (and
/// re-email every guest); there is no idempotency key in this API. 429 always
/// retries (the request was rejected, not executed).
async fn request_with_retry(
    http: &reqwest::Client,
    method: reqwest::Method,
    bearer: &str,
    url: &str,
    body: Option<&Value>,
    if_match: Option<&str>,
) -> Result<(reqwest::StatusCode, String), String> {
    let idempotent = method != reqwest::Method::POST;
    for attempt in 0..3u32 {
        let mut req = http.request(method.clone(), url).bearer_auth(bearer);
        if let Some(b) = body {
            req = req.json(b);
        }
        if let Some(etag) = if_match {
            req = req.header(reqwest::header::IF_MATCH, etag);
        }
        let resp = req
            .send()
            .await
            .map_err(|_| "Calendar request failed (network) — check your connection".to_string())?;
        let status = resp.status();
        if status.as_u16() == 429 || (idempotent && status.as_u16() >= 500) {
            tokio::time::sleep(std::time::Duration::from_millis(500 * 2u64.pow(attempt))).await;
            continue;
        }
        let body = resp.text().await.unwrap_or_default();
        if !status.is_success() && !idempotent && status.as_u16() >= 500 {
            return Err(format!(
                "Google Calendar had a server error saving the event — check your calendar \
                 before retrying (the event may have been created). {}",
                api_error(status, &body)
            ));
        }
        return Ok((status, body));
    }
    Err("Google Calendar rate-limited; try again shortly".to_string())
}

/// The Google request body for a draft. `existing` (the cached copy on
/// update) preserves current guests' RSVP state — the attendees array
/// overwrites wholesale, so unmerged emails would reset everyone to
/// needsAction.
pub fn event_body(draft: &crate::types::EventDraft, existing: Option<&CalendarEvent>) -> Value {
    let (start, end) = if draft.all_day {
        (
            serde_json::json!({ "date": local_date(draft.start_ms) }),
            serde_json::json!({ "date": local_date(draft.end_ms) }),
        )
    } else {
        (
            serde_json::json!({ "dateTime": rfc3339(draft.start_ms) }),
            serde_json::json!({ "dateTime": rfc3339(draft.end_ms) }),
        )
    };
    let attendees: Vec<Value> = draft
        .attendees
        .iter()
        .map(|email| {
            let known = existing.and_then(|e| {
                e.attendees.iter().find(|a| a.email.eq_ignore_ascii_case(email))
            });
            match known {
                Some(a) => serde_json::json!({
                    "email": a.email,
                    "optional": a.optional,
                    "responseStatus": a.response_status,
                }),
                None => serde_json::json!({ "email": email }),
            }
        })
        .collect();
    let mut body = serde_json::json!({
        "summary": draft.title,
        "location": draft.location,
        "description": draft.description,
        "start": start,
        "end": end,
        "attendees": attendees,
    });
    // Attach a Google Meet when asked — but never re-send createRequest for an
    // event that already has a conference (Google 400s / duplicates it), so this
    // fires on insert and on the first "add Meet" edit only. requestId must be
    // fresh-random per call: Google dedupes by it, and an id derived from the
    // event would attach the same conference twice. The insert/patch URL's
    // conferenceDataVersion=1 is what makes Google honor this block at all.
    if draft.add_conferencing && existing.map_or(true, |e| e.hangout_link.is_none()) {
        body["conferenceData"] = serde_json::json!({
            "createRequest": {
                "requestId": format!("fission-{:032x}", rand::random::<u128>()),
                "conferenceSolutionKey": { "type": "hangoutsMeet" },
            }
        });
    }
    body
}

/// One event, fresh from the server (conflict review + RSVP base).
pub async fn get_event(
    http: &reqwest::Client,
    bearer: &str,
    cal: &CalMeta,
    event_id: &str,
) -> Result<CalendarEvent, String> {
    let url = format!("{BASE}/calendars/{}/events/{}", enc(&cal.id), enc(event_id));
    let (status, body) = get_with_retry(http, bearer, &url).await?;
    if !status.is_success() {
        return Err(api_error(status, &body));
    }
    let v: Value =
        serde_json::from_str(&body).map_err(|_| "Calendar returned an unexpected response")?;
    parse_event(&v, cal).ok_or_else(|| "Calendar returned an event without times".to_string())
}

pub async fn insert_event(
    http: &reqwest::Client,
    bearer: &str,
    cal: &CalMeta,
    body: &Value,
    send_updates: &str,
) -> Result<CalendarEvent, String> {
    // conferenceDataVersion=1 lets Google honor a conferenceData.createRequest
    // in the body; without it the field is silently dropped (see event_body).
    let url = format!(
        "{BASE}/calendars/{}/events?sendUpdates={send_updates}&conferenceDataVersion=1",
        enc(&cal.id)
    );
    let (status, text) =
        request_with_retry(http, reqwest::Method::POST, bearer, &url, Some(body), None).await?;
    if !status.is_success() {
        return Err(api_error(status, &text));
    }
    let v: Value =
        serde_json::from_str(&text).map_err(|_| "Calendar returned an unexpected response")?;
    parse_event(&v, cal).ok_or_else(|| "Calendar returned an event without times".to_string())
}

pub async fn patch_event(
    http: &reqwest::Client,
    bearer: &str,
    cal: &CalMeta,
    event_id: &str,
    etag: Option<&str>,
    body: &Value,
    send_updates: &str,
) -> Result<WriteOutcome, String> {
    // conferenceDataVersion=1 so "add Meet on edit" (a createRequest in the
    // body) is honored rather than silently stripped.
    let url = format!(
        "{BASE}/calendars/{}/events/{}?sendUpdates={send_updates}&conferenceDataVersion=1",
        enc(&cal.id),
        enc(event_id),
    );
    let (status, text) =
        request_with_retry(http, reqwest::Method::PATCH, bearer, &url, Some(body), etag).await?;
    if status.as_u16() == 412 {
        let fresh = get_event(http, bearer, cal, event_id).await?;
        return Ok(WriteOutcome::Conflict(fresh));
    }
    if !status.is_success() {
        return Err(api_error(status, &text));
    }
    let v: Value =
        serde_json::from_str(&text).map_err(|_| "Calendar returned an unexpected response")?;
    parse_event(&v, cal)
        .map(WriteOutcome::Saved)
        .ok_or_else(|| "Calendar returned an event without times".to_string())
}

/// Delete an event. Ok(None) = gone (404/410 count — already deleted
/// elsewhere is success); Ok(Some(fresh)) = 412 conflict, review and retry.
pub async fn delete_event(
    http: &reqwest::Client,
    bearer: &str,
    cal: &CalMeta,
    event_id: &str,
    etag: Option<&str>,
    send_updates: &str,
) -> Result<Option<CalendarEvent>, String> {
    let url = format!(
        "{BASE}/calendars/{}/events/{}?sendUpdates={send_updates}",
        enc(&cal.id),
        enc(event_id),
    );
    let (status, text) =
        request_with_retry(http, reqwest::Method::DELETE, bearer, &url, None, etag).await?;
    if status.as_u16() == 412 {
        let fresh = get_event(http, bearer, cal, event_id).await?;
        return Ok(Some(fresh));
    }
    if status.is_success() || status.as_u16() == 404 || status.as_u16() == 410 {
        return Ok(None);
    }
    Err(api_error(status, &text))
}

/// RSVP: flip the account's own attendee record and patch the FULL guest
/// list back (the array overwrites wholesale). sendUpdates=all notifies the
/// organizer. No If-Match — your own response can't meaningfully conflict.
pub async fn rsvp(
    http: &reqwest::Client,
    bearer: &str,
    cal: &CalMeta,
    event_id: &str,
    response: &str,
) -> Result<WriteOutcome, String> {
    let fresh = get_event(http, bearer, cal, event_id).await?;
    if !fresh.attendees.iter().any(|a| a.self_) {
        return Err("You're not on this event's guest list".to_string());
    }
    let attendees: Vec<Value> = fresh
        .attendees
        .iter()
        .map(|a| {
            serde_json::json!({
                "email": a.email,
                "optional": a.optional,
                "responseStatus": if a.self_ { response } else { a.response_status.as_str() },
            })
        })
        .collect();
    let body = serde_json::json!({ "attendees": attendees });
    patch_event(http, bearer, cal, event_id, None, &body, "all").await
}

fn local_date(ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ms)
        .unwrap_or_else(chrono::Utc::now)
        .with_timezone(&chrono::Local)
        .format("%Y-%m-%d")
        .to_string()
}

/// Calendar flavor of the shared Google-403 classifier (mail/mod.rs).
fn classify_calendar_error(e: &str) -> String {
    crate::mail::classify_google_error(e, "Google Calendar API", "Calendar")
}

/// Local "midnight" of a calendar date as epoch ms, surviving DST edges:
/// some zones (Chile, Lebanon, …) spring forward AT midnight, so 00:00 may
/// not exist (fall back to 01:00) or exist twice (take the earlier).
pub fn local_day_start_ms(date: chrono::NaiveDate) -> Option<i64> {
    for hour in [0u32, 1] {
        if let Some(t) = date
            .and_hms_opt(hour, 0, 0)
            .and_then(|n| n.and_local_timezone(chrono::Local).earliest())
        {
            return Some(t.timestamp_millis());
        }
    }
    None
}

/// Google event times: {"dateTime": rfc3339} for timed, {"date": "YYYY-MM-DD"}
/// for all-day (interpreted as local midnight).
fn event_time(v: &Value) -> Option<(i64, bool)> {
    if let Some(dt) = v["dateTime"].as_str() {
        return chrono::DateTime::parse_from_rfc3339(dt)
            .ok()
            .map(|t| (t.timestamp_millis(), false));
    }
    if let Some(d) = v["date"].as_str() {
        let date = chrono::NaiveDate::parse_from_str(d, "%Y-%m-%d").ok()?;
        return local_day_start_ms(date).map(|ts| (ts, true));
    }
    None
}

fn rfc3339(ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ms)
        .unwrap_or_else(chrono::Utc::now)
        .to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{CalendarEvent, EventDraft};

    fn draft(add_conferencing: bool) -> EventDraft {
        EventDraft {
            calendar_id: "primary".into(),
            title: "Sync".into(),
            start_ms: 1_700_000_000_000,
            end_ms: 1_700_003_600_000,
            all_day: false,
            location: None,
            description: None,
            attendees: vec!["guest@example.com".into()],
            add_conferencing,
        }
    }

    /// A cached event carrying (or not) an existing Meet — the update merge base.
    fn existing(meet: Option<&str>) -> CalendarEvent {
        CalendarEvent {
            id: "evt1".into(),
            calendar_id: "primary".into(),
            calendar: "Primary".into(),
            color: None,
            title: "Sync".into(),
            start_ms: 1_700_000_000_000,
            end_ms: 1_700_003_600_000,
            all_day: false,
            location: None,
            description: None,
            html_link: None,
            etag: None,
            status: "confirmed".into(),
            organizer_email: None,
            organizer_self: true,
            recurring_event_id: None,
            hangout_link: meet.map(str::to_string),
            attendees: vec![],
            access_role: "owner".into(),
            ical_uid: None,
        }
    }

    fn create_request(body: &Value) -> Option<&Value> {
        body.get("conferenceData")?.get("createRequest")
    }

    #[test]
    fn insert_with_conferencing_injects_hangouts_meet_create_request() {
        let body = event_body(&draft(true), None);
        let cr = create_request(&body).expect("createRequest present on insert");
        assert_eq!(cr["conferenceSolutionKey"]["type"], "hangoutsMeet");
        assert!(
            cr["requestId"].as_str().is_some_and(|s| !s.is_empty()),
            "requestId must be a non-empty random token"
        );
    }

    #[test]
    fn insert_without_conferencing_omits_conference_data() {
        let body = event_body(&draft(false), None);
        assert!(body.get("conferenceData").is_none());
    }

    #[test]
    fn update_keeps_existing_meet_without_resending_create_request() {
        // Re-sending createRequest against an event that already has a Meet
        // 400s / duplicates the conference — it must be suppressed on update.
        let base = existing(Some("https://meet.google.com/abc-defg-hij"));
        let body = event_body(&draft(true), Some(&base));
        assert!(body.get("conferenceData").is_none());
    }

    #[test]
    fn update_adds_a_meet_when_the_event_has_none() {
        let base = existing(None);
        let body = event_body(&draft(true), Some(&base));
        assert!(
            create_request(&body).is_some(),
            "add-Meet-on-edit should inject createRequest"
        );
    }

    #[test]
    fn request_id_is_fresh_per_call_never_derived_from_the_event() {
        // Google dedupes conferences by requestId; a stable/derived id would
        // attach the same conference twice. Each call must produce a new one.
        let a = event_body(&draft(true), None);
        let b = event_body(&draft(true), None);
        let ra = create_request(&a).unwrap()["requestId"].as_str().unwrap();
        let rb = create_request(&b).unwrap()["requestId"].as_str().unwrap();
        assert_ne!(ra, rb, "requestId must be freshly random per request");
    }
}
