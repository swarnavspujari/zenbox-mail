//! Gmail OAuth 2.0 for desktop apps: loopback redirect + PKCE (S256).
//! The browser handles consent; we listen once on 127.0.0.1:<random port>,
//! exchange the code, and put the refresh token straight into the keychain.
use base64::Engine;
use rand::RngCore;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

const AUTH_URL: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
// gmail.modify: read + send + archive/label, but NOT permanent delete or
// account-level settings — the least privilege that covers the feature set.
// openid/email/profile give the account photo; calendar.readonly feeds the
// calendar side panel. Requested together so users consent exactly once.
const SCOPE: &str = "https://www.googleapis.com/auth/gmail.modify openid email profile https://www.googleapis.com/auth/calendar.readonly";

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    refresh_token: Option<String>,
    expires_in: Option<i64>,
}

pub struct OauthOutcome {
    pub access_token: String,
    pub refresh_token: String,
    pub expires_in: i64,
}

fn b64url(bytes: &[u8]) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

/// Runs the whole loopback flow. Returns tokens; caller persists them.
pub async fn run_flow(
    http: &reqwest::Client,
    app: &tauri::AppHandle,
    client_id: &str,
    client_secret: &str,
) -> Result<OauthOutcome, String> {
    let mut verifier_bytes = [0u8; 48];
    rand::thread_rng().fill_bytes(&mut verifier_bytes);
    let verifier = b64url(&verifier_bytes);
    let challenge = b64url(&Sha256::digest(verifier.as_bytes()));

    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|_| "could not open a loopback port".to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let redirect_uri = format!("http://127.0.0.1:{port}");

    let mut state_bytes = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut state_bytes);
    let state = b64url(&state_bytes);

    let auth_url = format!(
        "{AUTH_URL}?client_id={}&redirect_uri={}&response_type=code&scope={}&code_challenge={}&code_challenge_method=S256&access_type=offline&prompt=consent&state={}",
        urlencode(client_id),
        urlencode(&redirect_uri),
        urlencode(SCOPE),
        challenge,
        state
    );

    // Hand consent off to the default browser.
    tauri_plugin_opener::open_url(&auth_url, None::<String>)
        .map_err(|_| "could not open the browser for consent".to_string())?;

    // Wait (up to 5 minutes) for Google to redirect back with the code.
    let code = tokio::time::timeout(std::time::Duration::from_secs(300), async {
        loop {
            let (mut stream, _) = listener.accept().await.map_err(|e| e.to_string())?;
            let mut buf = vec![0u8; 8192];
            let n = stream.read(&mut buf).await.map_err(|e| e.to_string())?;
            let req = String::from_utf8_lossy(&buf[..n]);
            let first_line = req.lines().next().unwrap_or_default();
            // GET /?state=..&code=.. HTTP/1.1
            let path = first_line.split_whitespace().nth(1).unwrap_or_default();
            let url = url::Url::parse(&format!("http://localhost{path}"))
                .map_err(|e| e.to_string())?;
            let mut code = None;
            let mut got_state = None;
            let mut error = None;
            for (k, v) in url.query_pairs() {
                match k.as_ref() {
                    "code" => code = Some(v.to_string()),
                    "state" => got_state = Some(v.to_string()),
                    "error" => error = Some(v.to_string()),
                    _ => {}
                }
            }
            let (status, body) = if error.is_some() {
                ("200 OK", "<h2>ZenBox Mail</h2><p>Access was denied. You can close this tab and try again from the app.</p>")
            } else if code.is_some() && got_state.as_deref() == Some(state.as_str()) {
                ("200 OK", "<h2>ZenBox Mail</h2><p>Connected. You can close this tab and return to the app.</p>")
            } else {
                ("400 Bad Request", "<p>Unexpected request.</p>")
            };
            let resp = format!(
                "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nConnection: close\r\n\r\n<html><body style=\"font-family:sans-serif;background:#0e1014;color:#e8ecf4;display:flex;align-items:center;justify-content:center;height:100vh\"><div>{body}</div></body></html>"
            );
            let _ = stream.write_all(resp.as_bytes()).await;
            let _ = stream.shutdown().await;
            if let Some(e) = error {
                return Err(format!("consent was denied ({e})"));
            }
            if let (Some(c), Some(s)) = (code, got_state) {
                if s == state {
                    return Ok::<String, String>(c);
                }
            }
            // Ignore stray requests (favicon etc.) and keep listening.
        }
    })
    .await
    .map_err(|_| "timed out waiting for browser consent".to_string())??;

    let _ = app; // reserved for progress events

    let form = [
        ("client_id", client_id),
        ("client_secret", client_secret),
        ("code", code.as_str()),
        ("code_verifier", verifier.as_str()),
        ("grant_type", "authorization_code"),
        ("redirect_uri", redirect_uri.as_str()),
    ];
    let resp = http
        .post(TOKEN_URL)
        .form(&form)
        .send()
        .await
        .map_err(|_| "token exchange failed (network)".to_string())?;
    if !resp.status().is_success() {
        return Err(format!(
            "token exchange failed ({}) — check the client ID/secret and that {SCOPE} is enabled",
            resp.status()
        ));
    }
    let tok: TokenResponse = resp
        .json()
        .await
        .map_err(|_| "token exchange returned an unexpected response".to_string())?;
    Ok(OauthOutcome {
        access_token: tok.access_token,
        refresh_token: tok
            .refresh_token
            .ok_or("Google did not return a refresh token — remove the app's access at myaccount.google.com/permissions and retry")?,
        expires_in: tok.expires_in.unwrap_or(3500),
    })
}

pub async fn refresh_access_token(
    http: &reqwest::Client,
    client_id: &str,
    client_secret: &str,
    refresh_token: &str,
) -> Result<(String, i64), String> {
    let form = [
        ("client_id", client_id),
        ("client_secret", client_secret),
        ("refresh_token", refresh_token),
        ("grant_type", "refresh_token"),
    ];
    let resp = http
        .post(TOKEN_URL)
        .form(&form)
        .send()
        .await
        .map_err(|_| "token refresh failed (network)".to_string())?;
    if !resp.status().is_success() {
        return Err(format!("token refresh failed ({})", resp.status()));
    }
    let tok: TokenResponse = resp
        .json()
        .await
        .map_err(|_| "token refresh returned an unexpected response".to_string())?;
    Ok((tok.access_token, tok.expires_in.unwrap_or(3500)))
}

fn urlencode(s: &str) -> String {
    url::form_urlencoded::byte_serialize(s.as_bytes()).collect()
}
