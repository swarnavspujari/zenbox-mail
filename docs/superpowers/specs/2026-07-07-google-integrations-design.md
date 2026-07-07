# Google Integrations Design — Drive attachments, Calendar two-way sync, Contacts autocomplete

- **Date:** 2026-07-07
- **Status:** Approved design, pending user review
- **Baseline:** v0.11.2, commit `03436da` (main and this branch identical). All file:line anchors below are against this baseline — re-verify anchors if main has moved before building.
- **Decisions locked with the user:**
  1. Drive access = **full `drive` scope + custom in-app picker** (not Google's JS Picker).
  2. Calendar = **full two-way sync** (write-back, invites, RSVP), not just scope plumbing.
  3. Bundle **contacts.readonly + contacts.other.readonly + directory.readonly + gmail.settings.basic** into the same re-consent.
  4. Beta audience includes **external testers** → OAuth app stays External + Testing (7-day refresh-token expiry applies to everyone; see §3.5).

## 1. Summary

Two sequential builds:

- **Build A — Scopes + Drive + Contacts:** expand the OAuth scope block once, add a re-consent flow, build Google Drive attachments in the composer (pick from Drive → insert share-link chip; oversized local files auto-upload to Drive and send as a link, like Gmail), and real recipient autocomplete from Google Contacts / other contacts / Workspace directory, plus read-only send-as alias fetch.
- **Build B — Calendar two-way sync:** extend the read-only calendar into full CRUD with guests (real Google invites), RSVP from invite emails in the thread view, and a syncToken-based incremental sync engine.

Build B depends only on Build A's Phase A0 (the scope grant). Run them as separate sessions.

### Goals
- Attach-from-Drive and oversized-attachment→Drive-link flows with Gmail-parity UX, in the app's own design system.
- One re-consent for all new scopes; graceful degradation + per-feature "Reconnect" CTA when a grant is missing (users can uncheck boxes on Google's consent screen).
- Create/edit/delete Google Calendar events with attendees; invites and updates actually send; RSVP from mail.
- Contacts-powered recipient autocomplete.
- Full mock-backend parity for every new capability (browser demo must keep working).

### Non-goals (explicit)
- No Google Picker JS / no gapi / no CSP loosening (CSP currently blocks all Google JS + iframes by design — keep it that way).
- No contact write-back, no `gmail.settings.sharing`, no permanent-delete Gmail scope.
- No Calendar push channels (webhooks need a public HTTPS endpoint; polling stays).
- No offline write-queue for calendar edits in v1 (direct calls + optimistic UI; see §6.3).
- No Drive folder-tree browser in v1 (Recents + Search; folder browsing is a stretch goal).
- No inline-image / Content-ID work in outgoing MIME.
- No free-busy / scheduling UI (future project).

## 2. Scope strategy

New `SCOPE` constant in `src-tauri/src/mail/oauth.rs:17` (single space-separated block, one consent, matching the existing "consent exactly once" convention):

```
https://www.googleapis.com/auth/gmail.modify
https://www.googleapis.com/auth/gmail.settings.basic
openid email profile
https://www.googleapis.com/auth/calendar
https://www.googleapis.com/auth/drive
https://www.googleapis.com/auth/contacts.readonly
https://www.googleapis.com/auth/contacts.other.readonly
https://www.googleapis.com/auth/directory.readonly
```

| Scope | Tier | Why |
|---|---|---|
| `gmail.modify` | restricted (already held) | unchanged — read/send/labels/trash |
| `gmail.settings.basic` | restricted family | read send-as aliases + signatures |
| `calendar` (replaces `calendar.readonly`) | sensitive | event CRUD, invites, RSVP |
| `drive` | **restricted (new)** | browse/search all files, download, upload, set share permissions |
| `contacts.readonly` | sensitive | saved contacts autocomplete |
| `contacts.other.readonly` | sensitive | "Other contacts" (people you've emailed) |
| `directory.readonly` | sensitive | Workspace org directory autocomplete (no-op for consumer accounts) |

vs Superhuman: we stay **below** them on Gmail (`gmail.modify`, no permanent delete) and contacts (read-only, they take write), match on calendar + directory, skip `gmail.settings.sharing`, and **exceed** them with Drive. Verification posture is unchanged in kind: `gmail.modify` already puts the app in restricted/CASA territory if it ever verifies publicly; `drive` adds no new *category* of burden. In Testing/Internal status, none of this requires verification.

### Re-consent (critical)
There is **no incremental consent** in the app: `SCOPE` is a fixed block with `prompt=consent` (oauth.rs:64-71). Existing users' refresh tokens keep their old scopes; new API calls will 403 until they **Disconnect → Connect Gmail** (disconnect revokes server-side first, lib.rs:202-211, so the next connect is a clean full grant). Build A must:
- Persist each account's `granted_scope` (returned in `OauthOutcome.granted_scope`, oauth.rs:35) — store in the kv table, e.g. key `granted_scopes:{email}`.
- Feature-gate Drive / Calendar-write / Contacts / Settings features on the persisted grant; expose it to TS (simplest: a `get_capabilities(email)` command or extend the account payload).
- Show a one-time notice + a **"Reconnect to grant new access"** CTA (AccountTab) for accounts whose grant predates the new scopes — extend the existing `granted_scope` check + `app:notice` pattern (lib.rs:144-148, 183-188).
- Handle **partial grants**: Google's consent screen shows per-scope checkboxes. Any unchecked scope → that feature stays gated with its own Reconnect CTA, everything else works.
- Extend the 403 classifier pattern (`classify_calendar_error`, calendar.rs:95-119) to Drive and People calls so scope/API-disabled errors surface as actionable guidance, not raw errors.

## 3. Google Cloud setup (user runbook — do before running Build A)

1. [console.cloud.google.com](https://console.cloud.google.com) → select the project that owns the app's OAuth client (the one in `docs/GOOGLE_OAUTH.md`).
2. **APIs & Services → Library**: enable **Google Drive API** and **People API**. Verify **Gmail API** and **Google Calendar API** are already enabled.
3. **Google Auth Platform → Audience**: confirm User type = External, Publishing status = Testing. Under **Test users → Add users**: every beta tester's Google address (yours included). Hard cap 100.
4. **Google Auth Platform → Data Access → Add or remove scopes**: add the six new scopes from §2 — `drive`, `calendar`, `contacts.readonly`, `contacts.other.readonly`, `directory.readonly`, `gmail.settings.basic` (`gmail.modify` + openid/email/profile should already be listed; remove the stale `calendar.readonly` entry for hygiene). In Testing status this registry is informational — the app requests scopes at runtime — but keep it accurate; it becomes binding at verification time.
5. **Clients**: no changes. Same client ID/secret; the loopback (`http://127.0.0.1:{port}`) desktop flow needs no redirect-URI registration. No API key needed (no Google Picker).
6. After Build A ships: every existing user (owner included) must Disconnect → Connect Gmail once. The app will prompt (§2).
7. **7-day expiry mitigation (optional, owner only):** External+Testing refresh tokens expire weekly for everyone. To exempt yourself: create a second GCP project with Audience = **Internal** (your Workspace), enable the same four APIs, add the same scopes, create a Desktop OAuth client, and put that client ID/secret into your own install via the existing custom-credentials override (keychain `GMAIL_CLIENT_ID`/`GMAIL_CLIENT_SECRET` beats the baked-in beta client, secrets.rs:13-14, lib.rs:35-42). Internal apps: no verification, no user cap, no 7-day expiry. External testers stay on the shared baked-in client.
8. For Build B verification you'll want a **second Google account** to receive/RSVP invites.

## 4. Architecture ground rules (both builds)

- **The seam:** every new capability = six edits, in order: Rust type(s) in `src-tauri/src/types.rs` (`#[serde(rename_all = "camelCase")]`) → `#[tauri::command]` in `src-tauri/src/lib.rs` (validate inputs) → register in `generate_handler![...]` (lib.rs:2057-2114 — omission fails only at runtime) → mirror type in `src/lib/types.ts` → `Backend` method in `src/lib/ipc.ts` + `TauriBackend` wrapper → **`MockBackend` implementation in `src/lib/mock.ts` (mandatory parity)**. Then store slice + UI.
- **All Google I/O in Rust** via `reqwest`, riding the per-account `GmailSession::bearer()` (gmail.rs:111) exactly like `calendar.rs` does. New modules: `src-tauri/src/mail/drive.rs`, `src-tauri/src/mail/people.rs`; calendar writes extend `calendar.rs`.
- **CSP is untouchable** (tauri.conf.json:24): no Google scripts, iframes, or webview fetches to googleapis.com.
- **Large payloads must not cross IPC as base64 JSON.** For oversized uploads, either use Tauri v2 raw invoke bodies (`ArrayBuffer`/`Uint8Array` request payloads) or switch the oversized path to `tauri_plugin_dialog` native file picking (real paths, Rust streams from disk). Builder verifies both against Tauri v2 docs and picks; small files keep the existing FileReader→base64 path (`readFileB64`, useComposeController.ts:25-39).
- **Progress streaming:** per-request ordered progress = `tauri::ipc::Channel<T>` (precedent: `ai_draft`, lib.rs:1652-1696 ↔ ipc.ts:321-339). Broadcasts = `app.emit` (`mail:updated`, `calendar:updated` precedents).
- **Settings:** new flags go in the `Settings` struct (types.rs:77-106) **and** both defaults (`src/lib/defaults.ts`, `store/mod.rs:208`); saved-over-defaults merge handles upgrades.
- **Shortcuts/commands:** register in `src/lib/commands.ts` (`allCommands()`), default bindings in **both** `defaults.ts:29-104` and `store/mod.rs:209-289`, document in `docs/SHORTCUTS.md`.
- **Versioning:** bump `package.json` + `src-tauri/tauri.conf.json` + `src-tauri/Cargo.toml` in lockstep + numbered entries in `docs/DECISIONS.md`. No git tags (tags trigger the release pipeline) without explicit user go-ahead.
- **Docs:** update `docs/GOOGLE_OAUTH.md` scope table + re-consent note each build.

## 5. Build A — Scopes, Drive, Contacts

### A0 — Scope expansion + consent UX
Everything in §2. Acceptance: fresh Connect grants all scopes; pre-existing account shows Reconnect CTA; unchecking Drive on consent leaves mail working and Drive gated with its own CTA; `docs/GOOGLE_OAUTH.md` updated.

### A1 — `mail/drive.rs` (Rust core)
Functions (all take `&mut GmailSession`-style bearer access, all classified errors):
- `search(query, page_token)` → `files.list` with `q` (name contains + fullText), `orderBy=viewedByMeTime desc` for the recents case (empty query), `supportsAllDrives=true&includeItemsFromAllDrives=true`, fields: id, name, mimeType, size, webViewLink, iconLink, modifiedTime, owners. Escape user input in `q`.
- `download(file_id)` → `files.get?alt=media` streamed to bytes → returns a `MailAttachment` (reject > inline limit before downloading using metadata `size`).
- `ensure_app_folder()` → find-or-create folder named **"Fission Mail Attachments"** (cache folderId in kv).
- `upload(source, name, mime, channel)` → resumable upload session (`uploadType=resumable`, chunked PUTs) streaming progress over `Channel<DriveUploadProgress { sent, total }>`; returns file id + webViewLink.
- `share(file_id, mode, emails)` → `permissions.create`; `mode ∈ {recipients (type=user, role=reader, sendNotificationEmail=false, one call per address), anyone (type=anyone, role=reader)}`. Full `drive` scope permits this on any file the user can share, including picked existing files.
New types: `DriveFile`, `DriveUploadProgress`, share mode enum. Commands: `drive_search`, `drive_download_attach`, `drive_upload`, `drive_share`. Mock: fixture file list, fake progress ticks, no-op share — enough to demo the whole flow in the browser.

### A2 — Drive picker UI
- New `Picker` union member `"drivePicker"` (ui.ts:169-176) mounted with the others (App.tsx:256-261), built on **PickerShell** (`src/features/pickers/PickerShell.tsx`) with async items: opens showing Recents, debounced `drive_search` as you type; rows show file-type glyph, name, size/modified detail.
- **Enter** = insert as Drive **link chip** (default, matches Gmail). Secondary action (shown in row detail / footer hint) = **attach as copy** for files ≤ inline limit (downloads via `drive_download_attach` and appends to `attachments`).
- Entry points: paperclip flyout in Compose + ReplyDock ("Attach from Drive"), a command "Attach from Google Drive" gated `when` a composer is open, and a default shortcut chosen per existing keymap conventions (avoid collisions; register in both defaults maps).
- Gated on the Drive capability (§A0); ungated → CTA row linking to Settings→Account Reconnect.

### A3 — Oversized flow, link chips, share-on-send
- `ComposeState` gains `driveLinks: DriveLinkRef[]` (`{fileId, name, url, size?, pendingUploadId?}`).
- **Chip markup:** email-safe inline-styled anchor block (rounded bordered box: glyph + filename, `href=webViewLink`) inserted at caret via TipTap `insertContent`; plain-text fallback (in `outgoingFromCompose`'s text path) as `name — url` on its own line. **Must survive `sanitizeUserHtml`** — inspect the sanitizer and extend its allowlist minimally (e.g. `style` on `a`/`span`, https-only hrefs) if required; do not weaken it generally.
- **Oversized interception:** in `addFiles` (useComposeController.ts:133-158), where the `MAX_ATTACH_TOTAL = 25_000_000` check currently errors-and-breaks (:137-148): instead offer per-file "Too big to attach — upload to Google Drive and insert a link?" (confirm modal; remember-my-choice setting `driveAutoUpload: "ask" | "always"`). Accepted → upload to the app folder with a **pending chip** in the composer showing live progress (Channel), then swap to the real chip. Failure → error toast + chip removed. Keep the three size gates coherent (frontend 25 MB, Rust base64 33 MB lib.rs:1467-1471, outbox JSON) — inline attachments must still respect them; Drive links bypass them by construction.
- **Share-on-send:** in the send path (useComposeController.ts:77-131), if `driveLinks` non-empty, show a dialog before `queueMail`: **"Share with recipients (view)"** (default) / "Anyone with the link (view)" / "Don't change access". Apply via `drive_share` for all to/cc/bcc; per-address failures → warning toast listing addresses, send proceeds. Remember last choice (`settings.driveShareMode`). Undo Send needs no special handling (chips are body HTML; an unsent upload simply remains in the Drive folder — acceptable, record in DECISIONS).

### A4 — Contacts autocomplete
- `mail/people.rs`: `connections.list` (personFields `names,emailAddresses,photos`), `otherContacts.list`, `people.listDirectoryPeople` (skip gracefully when directory scope/data absent — consumer accounts). Paginate fully.
- SQLite `contacts` table (account_id, email, display_name, source ∈ {contact, other, directory}, photo_url nullable, updated_at); replace-on-sync per account+source. Sync on connect, daily background refresh, manual "Refresh contacts" in settings.
- `RecipientInput` (`src/features/compose/RecipientInput.tsx`): inspect current suggestion source; merge contacts table via a `search_contacts(prefix)` command, dedup by email, rank: exact/prefix match > existing history signal > contacts > other > directory. Keep ranking simple and fast (SQL prefix query + in-memory sort).
- Mock: seeded fixture contacts so the demo autocompletes.

### A5 — Send-as read (small)
- Fetch `users.settings.sendAs` at connect / on demand; persist to kv `sendas:{email}`; AccountTab shows aliases (read-only list, marks default + its signature availability).
- **Stretch (only if A0–A4 verified):** From-alias dropdown in compose shells; `build_rfc822` already takes `from` (gmail.rs:638) — send with the alias address after validating it's a verified sendAs entry.

## 6. Build B — Calendar two-way sync + invites

Depends on A0's `calendar` grant only. Current state: read-only, lossy model, SQLite window cache, 5-min rolling refresh (-7d..+21d, lib.rs:2023-2047).

### B0 — Event model + migration
- Extend `CalendarEvent` (types.rs:149-160) with: `description`, `html_link`, `etag`, `status`, `organizer_email`, `organizer_self`, `recurring_event_id`, `hangout_link` (read-only surface), `attendees: Vec<EventAttendee>`, `calendar_id` (the raw id — today `calendar` holds a display name; keep both), `access_role` of the parent calendar (for edit gating). `EventAttendee { email, display_name?, optional?, response_status, self_, organizer? }`.
- **Inspect how `store/mod.rs` handles schema evolution** (tables are created idempotently at :115-130; there may be no ALTER mechanism yet). Add columns via guarded `ALTER TABLE` (ignore duplicate-column errors) or a versioned migration — follow whatever precedent exists; if none, establish the guarded-ALTER pattern and note it in DECISIONS.
- Update the event parse (calendar.rs:75-84), `replace_events`, mock `demo_events` (both mock.ts:534 and mock.rs — keep the "keep in sync" comment honest), and the TS mirror.

### B1 — Sync engine
- Per-calendar **syncToken** incremental sync: kv `cal_sync:{email}:{calendarId}`. Initial fetch = windowed full list (keep `singleEvents=true`; widen window to about -30d..+365d), capture `nextSyncToken`; increments call `events.list` with `syncToken` (drop `orderBy`/`timeMin` — invalid with syncToken), apply upserts + `status=cancelled` deletions; **410 Gone → drop token, full window refetch**.
- Cadence: keep the 5-min background loop, add on-focus refresh and an immediate incremental pull after any local write. Fetch `calendarList` with `accessRole` so the UI knows which calendars are writable.
- The existing read path/commands (`list_events`, `refresh_calendar`, `calendar:updated`) keep their shapes; sync internals change underneath.

### B2 — Write commands
- `create_event`, `update_event`, `delete_event`, `rsvp_event` as direct Google calls (online-required; classified errors offline/permission). Create/update accept the full editable surface (title, start/end incl. all-day, attendees, location, description, calendar_id).
- **Concurrency:** send `If-Match: etag` on update/delete; on 412 → refetch the event, surface "This event changed elsewhere — review and retry" with the fresh copy.
- **Guest notifications:** when the event has attendees, prompt "Send invites/updates to guests?" mapping to `sendUpdates=all|none` (default all). RSVP = patch only your own attendee `responseStatus` with `sendUpdates=all` so the organizer is notified.
- Optimistic local upsert → reconcile from the response; failures roll back + toast. No write queue in v1 (recorded non-goal).
- Mock parity: full CRUD + RSVP over the demo event store.

### B3 — Calendar UI
- **Event modal** (create/edit): title, calendar selector (writable only), date/time or all-day, attendees via the A4 autocomplete component, location, description, notify-guests control on save. Open via: click/drag on empty slots in `CalendarPanel`/`CalendarWeek`, an event's popover Edit, and a "New event" command (+ shortcut registered per convention; mind `c` = compose collision — use a calendar-context binding).
- **Event popover** on click: details incl. guest list with RSVP states, organizer, Meet link if present; actions: Edit / Delete (owner) or RSVP Yes-Maybe-No (attendee), gated by `access_role`/organizer.
- Read-only calendars render as today (no edit affordances).

### B4 — Invites in the mail pane
- Detect invite messages: `text/calendar` MIME part or `.ics` attachment with `METHOD:REQUEST` (parse UID, organizer, DTSTART/DTEND, SUMMARY — a tiny tolerant parser, not a full iCal library, unless a suitable maintained crate is already a transitive dep).
- RSVP bar above the message in `ThreadView`: event summary + Accept / Tentative / Decline reflecting current status. Resolution: `events.list?iCalUID={uid}` on the user's calendars → `rsvp_event`. Unresolvable (not yet on calendar) → fallback button "Open in Google Calendar" (htmlLink from the ics or calendar.google.com render link). Cancellations (`METHOD:CANCEL`) render an informational strip.
- Mock: the existing demo "Invitation:" threads (mock.rs:191-225) get a working RSVP bar against the mock store.

## 7. Error handling & edge cases (both builds)
- Extend the `classify_calendar_error` approach into a shared helper: 401 → token refresh retry once; 403 `insufficientPermissions`/`accessNotConfigured` → capability-specific guidance ("Reconnect to grant Drive access" / "Enable the Drive API"); 404/410/412 handled per-flow (above); network → retryable toast.
- **Weekly token death (External+Testing):** refresh failure with `invalid_grant` must surface as a per-account "Session expired — reconnect Gmail" state (banner + AccountTab CTA), not silent sync stalls. Verify current behavior and wire the state through; this hits every tester weekly, so it must be one click.
- Partial consent (per-scope checkboxes) → §A0 gating; never hard-fail app start.
- Drive upload interrupted (app quit mid-upload): v1 = orphaned session is abandoned, pending chip removed on restart (compose state is in-memory) — acceptable; note in DECISIONS.
- Share failures for external recipients on Workspace-restricted files → warning with addresses, send anyway (Gmail behaves similarly).

## 8. Verification plan
- **Per phase:** `npm run build` (tsc + vite) and `cargo check` clean; exercise the real flow in `npm run tauri dev` against the owner's account; exercise the mock path in the browser (`npm run dev`). No phase is "done" on compile alone — each acceptance line above must be demonstrated.
- **Real-account E2E for Build A:** pick an existing Drive file → chip → send to second account → link opens with view access; attach 30 MB local file → auto-upload → progress → chip → send; recipient without access + "share with recipients" → opens.
- **Real-account E2E for Build B:** create event with second-account guest → invite email arrives → RSVP from Fission on the guest side → organizer sees status; edit time with "notify guests"; If-Match conflict simulated by editing in Google Calendar web + then in Fission.
- **End of each build:** fresh-context code-review pass (review subagent) over the full diff; fix what it confirms. Version bump + DECISIONS.md + GOOGLE_OAUTH.md. No tags/releases without the user.

## 9. Risks / open items the builder resolves in-flight
1. `sanitizeUserHtml` allowlist vs chip markup — inspect and minimally extend (§A3).
2. SQLite schema-evolution precedent — inspect; establish guarded-ALTER if absent (§B0).
3. Oversized-bytes IPC mechanism — Tauri v2 raw invoke body vs dialog-plugin paths; verify against docs, pick one (§4).
4. `RecipientInput` current suggestion source — inspect before merging contacts (§A4).
5. Recurring-event editing semantics (this-event vs series) — v1 ships **series-master + single instances as Google returns them** (singleEvents=true); editing an instance edits that instance (Google API handles the exception record). Anything fancier is out of scope.
6. Google API request/response field details — verify against current Google reference docs (WebFetch) rather than assuming; API shapes in this spec are directional.

## 10. Anchor quick-reference

| Concern | Where |
|---|---|
| OAuth flow + SCOPE | `src-tauri/src/mail/oauth.rs` (:17 scope, :64 params, :35 granted_scope) |
| Sessions/refresh/bearer | `src-tauri/src/mail/gmail.rs` (:28,:111,:115-133) |
| Keychain | `src-tauri/src/secrets/mod.rs` (client override :13-14; per-account refresh :20-22) |
| Commands + `generate_handler!` | `src-tauri/src/lib.rs` (:2057-2114) |
| Calendar read + 403 classifier | `src-tauri/src/mail/calendar.rs` (:11-89, :95-119) |
| SQLite (events/outbox/kv/settings) | `src-tauri/src/store/mod.rs` |
| IPC types | `src-tauri/src/types.rs` ↔ `src/lib/types.ts` |
| Seam + mock | `src/lib/ipc.ts` (Backend :50-151) ↔ `src/lib/mock.ts` |
| Compose logic (attach/send/undo) | `src/features/compose/useComposeController.ts` (:16 limit, :133 addFiles, :77 send) |
| Compose → OutgoingMail (+sanitizer) | `src/stores/ui.ts` `outgoingFromCompose` (:135-167) |
| Composer shells / editor | `Compose.tsx`, `ReplyDock.tsx`, `ComposeEditor.tsx`, `RecipientInput.tsx` |
| Picker primitive + registry | `src/features/pickers/PickerShell.tsx`; `Picker` union ui.ts:169-176; mount App.tsx:256-261 |
| Commands/shortcuts | `src/lib/commands.ts`; defaults `src/lib/defaults.ts:29-104` ↔ `store/mod.rs:209-289` |
| Settings UI | `src/features/settings/SettingsScreen.tsx` (AccountTab :108-293) |
| Progress channel precedent | `ai_draft` lib.rs:1652-1696 ↔ ipc.ts:321-339 |
| CSP / version / updater | `src-tauri/tauri.conf.json` (:24 CSP) |
| Changelog / OAuth docs | `docs/DECISIONS.md`, `docs/GOOGLE_OAUTH.md` |
