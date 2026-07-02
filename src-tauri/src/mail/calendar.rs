//! Google Calendar (read-only) for the side panel. Rides the account's Gmail
//! OAuth session — the calendar.readonly scope is requested at connect time.
use crate::mail::gmail::GmailSession;
use crate::types::CalendarEvent;
use serde_json::Value;

const BASE: &str = "https://www.googleapis.com/calendar/v3";
const MAX_CALENDARS: usize = 10;

/// Events across the user's calendars in [start_ms, end_ms), sorted by start.
pub async fn list_events(
    http: &reqwest::Client,
    session: &mut GmailSession,
    start_ms: i64,
    end_ms: i64,
) -> Result<Vec<CalendarEvent>, String> {
    let time_min = rfc3339(start_ms);
    let time_max = rfc3339(end_ms);

    let cal_list = session
        .get_json(http, &format!("{BASE}/users/me/calendarList?maxResults=50"))
        .await
        .map_err(|e| {
            if e.contains("(403") {
                // scope missing: account connected before calendar.readonly
                "calendar access not granted — disconnect and reconnect Gmail to enable it".to_string()
            } else {
                e
            }
        })?;
    let empty = vec![];
    let calendars: Vec<(String, String, Option<String>)> = cal_list["items"]
        .as_array()
        .unwrap_or(&empty)
        .iter()
        .filter(|c| c["selected"].as_bool().unwrap_or(true))
        .filter_map(|c| {
            Some((
                c["id"].as_str()?.to_string(),
                c["summary"].as_str().unwrap_or("Calendar").to_string(),
                c["backgroundColor"].as_str().map(str::to_string),
            ))
        })
        .take(MAX_CALENDARS)
        .collect();

    let mut events: Vec<CalendarEvent> = vec![];
    for (cal_id, cal_name, color) in calendars {
        let url = format!(
            "{BASE}/calendars/{}/events?timeMin={}&timeMax={}&singleEvents=true&orderBy=startTime&maxResults=100",
            url::form_urlencoded::byte_serialize(cal_id.as_bytes()).collect::<String>(),
            url::form_urlencoded::byte_serialize(time_min.as_bytes()).collect::<String>(),
            url::form_urlencoded::byte_serialize(time_max.as_bytes()).collect::<String>(),
        );
        // one broken calendar shouldn't blank the whole panel
        let Ok(v) = session.get_json(http, &url).await else { continue };
        for item in v["items"].as_array().unwrap_or(&empty) {
            if item["status"].as_str() == Some("cancelled") {
                continue;
            }
            let Some((start, all_day)) = event_time(&item["start"]) else { continue };
            let end = event_time(&item["end"]).map(|(t, _)| t).unwrap_or(start);
            events.push(CalendarEvent {
                id: item["id"].as_str().unwrap_or_default().to_string(),
                calendar: cal_name.clone(),
                color: color.clone(),
                title: item["summary"].as_str().unwrap_or("(busy)").to_string(),
                start_ms: start,
                end_ms: end,
                all_day,
                location: item["location"].as_str().map(str::to_string),
            });
        }
    }
    events.sort_by_key(|e| e.start_ms);
    Ok(events)
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
        let local = date.and_hms_opt(0, 0, 0)?;
        let ts = local
            .and_local_timezone(chrono::Local)
            .single()
            .map(|t| t.timestamp_millis())?;
        return Some((ts, true));
    }
    None
}

fn rfc3339(ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ms)
        .unwrap_or_else(chrono::Utc::now)
        .to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}
