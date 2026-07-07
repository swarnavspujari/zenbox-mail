# Google OAuth: what your testers will see, and what verification takes

Fission uses one Google Cloud OAuth client (project `fission-mail`, Desktop-app
type). Since v0.15 it requests one fixed scope block covering Gmail, Calendar
(full), Drive, Contacts, and send-as settings — users consent exactly once.
This page covers the consent-screen states, exactly what beta testers
experience, and the path past 100 users.

## The three consent-screen states

| State | Who can connect | Token lifetime | What users see |
|---|---|---|---|
| **Testing** | Only emails on the test-user list (max 100) | **Refresh tokens expire after 7 days** — users must reconnect weekly | Normal consent screen |
| **In production, unverified** | Anyone, capped at **100 total users** for sensitive/restricted scopes | Tokens don't expire | **"Google hasn't verified this app"** interstitial |
| **In production, verified** | Anyone, no cap | Tokens don't expire | Normal consent screen |

**Action for the beta: publish to production (unverified).** Testing mode's
7-day token expiry means every tester silently loses sync weekly — that is
the "debugging over their shoulder" scenario. Publishing takes one click and
does *not* require verification up front.

## One-time console steps (you must do these)

1. **Enable the APIs the app calls.** ☰ → *APIs & Services* → *Library*, in
   project `fission-mail`, and **Enable** all four:
   - **Gmail API**
   - **Google Calendar API** — easy to miss, and this is the one that bites:
     until it's enabled the calendar panel returns a 403
     (`accessNotConfigured` / "has not been used in project …") for **every**
     tester, no matter how many times they reconnect. Enabling it here fixes it
     for all testers at once. (Newly enabled APIs can take a minute to propagate.)
   - **Google Drive API** (v0.15+) — Drive attachments and oversized-file
     share links 403 with the same `accessNotConfigured` until it's on.
   - **People API** (v0.15+) — contacts autocomplete.
2. <https://console.cloud.google.com/apis/credentials/consent> → project
   `fission-mail`.
3. Confirm **User type: External**.
4. Fill the required fields if empty: app name "Fission Mail", user support
   email, developer contact email. (Logo optional — adding one *triggers*
   brand verification review; skip it for now.)
5. Click **Publish app** → confirm "Push to production".
6. That's it. No submission for verification yet.

## What a tester experiences (send them this, verbatim)

> When you click **Connect Gmail**, your browser opens a Google sign-in page.
> Because Fission is a small beta, Google shows a warning screen:
>
> **"Google hasn't verified this app"**
>
> 1. Click **Advanced** (bottom left).
> 2. Click **Go to fission-mail (unsafe)** — it's your own mailbox, on your
>    own computer; nothing leaves your machine.
> 3. Check the box granting access to Gmail and click **Continue**.
>
> You'll land back in Fission with your inbox syncing.

Notes:
- The unverified-app screen appears for **every new user**, once.
- The 100-user cap counts *total unique Google accounts ever granted*, not
  concurrent users. Fine for a friends beta; a public launch needs
  verification.

## Beyond 100 users: full verification for `gmail.modify`

`gmail.modify` is a **restricted** scope (the strictest Gmail tier). Getting
verified requires, in order:

1. **Domain & branding**: a homepage you own (domain-verified in Search
   Console), a privacy policy URL on that domain, and app branding review.
   Budget: a weekend of work + the OAuth review's 3–7 business days.
2. **Scope justification**: a short written case for why read/label/send
   access is needed (a mail client is the canonical accepted case) and a
   YouTube demo video of the OAuth flow + scope usage.
3. **CASA security assessment** (annual, required for restricted scopes):
   a third-party lab (e.g. TAC Security, DEKRA, Leviathan) assesses against
   the OWASP-based CASA Tier 2 standard. For a local-first desktop app the
   scan surface is small. **Cost: roughly $500–$4,500/yr** depending on lab
   and tier — the real cost of going public, so decide before marketing
   beyond friends.
4. Timeline end-to-end: typically **4–8 weeks**.

Cheaper alternatives if the cap ever bites before verification:
- Switch to `gmail.readonly` + `gmail.send`? **No** — both are also
  restricted; archiving/labeling (the core of Fission triage) needs modify
  anyway. There is no non-restricted scope that can do this job.
- Have power users create their **own** OAuth client (Fission already accepts
  pasted client credentials in Settings → Account). Each personal client has
  its own 100-user pool of one. Nerd-friendly escape hatch, not a
  mainstream one; documented in docs/SETUP.md.

## Scopes Fission requests

| Scope | Why | Tier |
|---|---|---|
| `gmail.modify` | read, archive, label, star, trash, send | restricted |
| `gmail.settings.basic` (v0.15+) | read send-as aliases + signatures | restricted family |
| `openid email profile` (v0.6+) | account email + profile photo in the UI | non-sensitive |
| `calendar` (v0.15+, replaces `calendar.readonly`) | calendar panel today; event CRUD/invites next | sensitive |
| `drive` (v0.15+) | attach from Drive, upload oversized attachments, set share permissions on send | restricted |
| `contacts.readonly` (v0.15+) | saved-contacts recipient autocomplete | sensitive |
| `contacts.other.readonly` (v0.15+) | "Other contacts" (people you've emailed) autocomplete | sensitive |
| `directory.readonly` (v0.15+) | Workspace directory autocomplete (no-op on consumer accounts) | sensitive |

### Re-consent (v0.15): every existing user reconnects once

There is **no incremental consent** — the app requests one fixed block with
`prompt=consent`. Existing refresh tokens keep their old scopes, so Drive /
People calls 403 until the user does **Disconnect → Connect Gmail** once
(disconnect revokes server-side first, so the next connect is a clean full
grant). The app detects pre-v0.15 grants, shows a one-time notice, and offers
a **"Reconnect to grant new access"** button in Settings → Account.

Google's consent screen shows **per-scope checkboxes** — a user can grant
Gmail but skip Drive. The app records exactly what was granted
(`granted_scopes` per account) and gates each feature independently; a
skipped scope just keeps that feature off, with the same Reconnect CTA.

Verification posture: `gmail.modify` already put the app in
restricted/CASA territory; `drive` is also restricted but adds no new
*category* of burden. In Testing/Internal status none of this requires
verification. The Data Access scope registry in the console should list the
full block (informational while in Testing; binding at verification time).
