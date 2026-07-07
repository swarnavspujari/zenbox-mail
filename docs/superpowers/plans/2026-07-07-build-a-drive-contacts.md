# Build A — Google scopes + Drive attachments + contacts autocomplete: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (inline) to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the approved design's Build A (spec: `docs/superpowers/specs/2026-07-07-google-integrations-design.md` §5): OAuth scope expansion + re-consent UX, `mail/drive.rs`, Drive picker, oversized-attachment→Drive-link flow with share-on-send, People-API contacts autocomplete, send-as read.

**Architecture:** Every capability follows the six-edit seam (types.rs → lib.rs command → generate_handler → types.ts → ipc.ts Backend + TauriBackend → mock.ts parity), then store slice + UI. All Google I/O in Rust over the per-account `GmailSession::bearer()`. CSP untouched.

**Tech stack:** Tauri v2 (raw invoke bodies for oversized bytes), reqwest, rusqlite, React/TS, TipTap.

**Baseline correction (build-time discovery):** the spec's v0.11.2 baseline was stale — releases v0.12.0→v0.14.0 shipped from a side branch and never merged to main (beta users run 0.14.0). This branch was rebased onto **v0.14.0** (`26a78a5`). Composer anchors changed: the shells decomposed into shared `ComposeShell.tsx` + `RecipientFields.tsx` + `AttachmentChips.tsx` + `ComposeActionBar.tsx` + `ComposeAiBar.tsx` — A2/A3 edits land there (once, not per-shell). v0.13 added `undoSendSeconds` + outbox claim + `sendMailNow`/`sendOutboxNow` (share-on-send must run before BOTH send paths); v0.14 added `shortcuts-catalog.ts` (new command gets a catalog entry) and keymap changes. **Version bump target is 0.15.0**, not 0.12.0.

---

## Resolved §9 mechanism decisions (verified against current docs 2026-07-07)

1. **Oversized bytes → Rust: chunked raw invoke bodies, no Channel needed.**
   Verified: Tauri v2 `invoke(cmd, new Uint8Array(...), { headers: {...} })` sends a raw body; Rust receives `tauri::ipc::Request` → `InvokeBody::Raw(Vec<u8>)` + `request.headers()`. A raw-body request carries no JSON args, so a `Channel` can't ride along — instead the **frontend slices the File into 4 MiB chunks** (multiple of 256 KiB per Google's resumable-upload rule) and invokes `drive_upload_chunk` per chunk; Rust PUTs each chunk to the resumable session URI with `Content-Range`. Progress falls out of the chunk loop in the frontend — exact, ordered, no Rust→JS channel, bounded memory (never the whole file in RAM), and the base64-JSON path is never touched. The spec's `DriveUploadProgress` Channel type is therefore unnecessary; recorded as a DECISIONS deviation.
   - Rejected: dialog-plugin native picking (changes attach UX; webview `File`s have no paths on WebView2); single raw-body invoke (whole file in memory, no progress).
2. **`sanitizeUserHtml` needs no loosening for chips.** It is a *blocklist* sanitizer (strips script/iframe/object/embed/link/meta/form/base, `on*` attrs, `javascript:` URLs); inline `style` on `<a>` passes today. The real constraint is the **TipTap schema**: chips survive only if the Link mark keeps `style` + `data-drive-chip`. Extend the Link mark's attributes (contained, both shells).
3. **RecipientInput suggestion source** = `backend.searchContacts` → Rust `store::search_contacts` over the mail-derived `contacts` table (freq/last_seen = the "history signal"). Merge happens server-side; the component doesn't change.
4. **Google API shapes verified:** resumable upload (POST `upload/drive/v3/files?uploadType=resumable` → `Location` session URI; PUT chunks `Content-Range: bytes a-b/total`; 308 = continue w/ `Range` header, 200/201 = done; 404 = session expired). `permissions.create` (`sendNotificationEmail` defaults true for user/group, may be false for reader). `connections.list` uses **personFields**; `otherContacts.list` and `listDirectoryPeople` use **readMask**; all paginate w/ pageToken, pageSize ≤1000. Directory sources: `DIRECTORY_SOURCE_TYPE_DOMAIN_PROFILE` (+`DOMAIN_CONTACT`); consumer accounts → skip gracefully on error.
5. **Chip insertion into the editor** goes through the editor instance via a window CustomEvent (`fission:insert-html`), following the `fission:compose-field` precedent. (The store-body route SnippetPicker uses is broken since the v0.10 uncontrolled-editor migration — do not copy it.)

## File map

| Area | Files |
|---|---|
| A0 | `src-tauri/src/mail/oauth.rs` (SCOPE), `src-tauri/src/lib.rs` (persist grant, get_capabilities, notice), `src/lib/types.ts`, `src/lib/ipc.ts`, `src/lib/mock.ts`, `src/stores/settings.ts` (caps cache), `src/features/settings/SettingsScreen.tsx` (Reconnect CTA), `docs/GOOGLE_OAUTH.md` |
| A1 | new `src-tauri/src/mail/drive.rs`, `src-tauri/src/mail/mod.rs`, `src-tauri/src/types.rs` (DriveFile, DriveShareMode), `src-tauri/src/lib.rs` (5 commands + uploads state), seam files |
| A2 | `src/features/pickers/DrivePicker.tsx` (new), `PickerShell.tsx` (async query + alt-run), `src/stores/ui.ts` (Picker union), `src/App.tsx` (mount), `src/lib/commands.ts`, `src/lib/defaults.ts` + `store/mod.rs` (shortcut), `Compose.tsx`/`ReplyDock.tsx` (attach flyout), `docs/SHORTCUTS.md` |
| A3 | `src/stores/ui.ts` (driveLinks, chip html, htmlToText chip case, prompts state), `useComposeController.ts` (oversized interception, share-on-send), `ComposeEditor.tsx` (ChipLink mark, insert event), shells (pending-chip strip, modals), `types.rs`/`types.ts` Settings (`driveAutoUpload`, `driveShareMode`) + both defaults |
| A4 | new `src-tauri/src/mail/people.rs`, `store/mod.rs` (people_contacts table + merge in search_contacts), `lib.rs` (sync triggers + refresh_contacts command), mock.ts fixture contacts, SettingsScreen (Refresh contacts) |
| A5 | `lib.rs` (get_send_as + fetch at connect), kv `sendas:{email}`, SettingsScreen alias list, seam + mock |
| Wrap | `package.json` + `tauri.conf.json` + `Cargo.toml` = 0.12.0, `docs/DECISIONS.md` (#87+), `docs/GOOGLE_OAUTH.md` |

---

## Task A0: scope expansion + re-consent

- [ ] `oauth.rs:17` — replace `SCOPE` with the §2 block (single space-separated string):
  `https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/gmail.settings.basic openid email profile https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/contacts.readonly https://www.googleapis.com/auth/contacts.other.readonly https://www.googleapis.com/auth/directory.readonly`
- [ ] `types.rs` + `types.ts`: `Capabilities { drive, contacts, calendar_write, settings_read, legacy_grant }` (camelCase over IPC; `legacy_grant` = connected before grant tracking → needs reconsent).
- [ ] `lib.rs start_oauth`: persist `granted_scopes:{email}` = raw granted string (kv). Replace the calendar-only warning with a generic one listing skipped features (calendar/drive/contacts). Kick a people-sync + sendAs fetch (A4/A5 hooks — added in those phases).
- [ ] `lib.rs`: `#[tauri::command] fn get_capabilities(email) -> Capabilities` — parse kv `granted_scopes:{email}`; missing kv on a gmail account → all-false + `legacy_grant: true`. Mock accounts → all true. Register in `generate_handler!`.
- [ ] Startup one-time notice: in setup, for each gmail account without `granted_scopes:{email}` kv, emit `app:notice` "New Google features need a one-time reconnect…" gated by kv `scope_notice_shown:{email}`.
- [ ] Seam: `Backend.getCapabilities(email)`; TauriBackend invoke; MockBackend returns all-true. Cache in `useSettings` (`capabilities: Record<email, Capabilities>`, loaded with accounts).
- [ ] AccountTab: for gmail accounts with `legacyGrant` or any missing capability → amber strip "Reconnect to grant new Google access (Drive, Contacts…)" + **Reconnect** button = `disconnect(email)` → `startOauth("","")` → refresh accounts+caps.
- [ ] `docs/GOOGLE_OAUTH.md`: scope table (all 8), re-consent note, API-enablement step for Drive/People.
- [ ] Verify: `npm run build`, `cargo check`. Real: fresh Connect → all scopes granted (inspect stored `granted_scopes`); existing account shows CTA; partial grant (uncheck Drive) → mail works, Drive gated. Mock: browser demo unaffected, caps all-true.

## Task A1: `mail/drive.rs`

- [ ] `types.rs`/`types.ts`: `DriveFile { id, name, mime_type, size: Option<i64>, web_view_link, icon_link: Option<String>, modified_time: Option<String>, owner: Option<String> }`; share mode = plain String validated in command (`"recipients" | "anyone"`).
- [ ] Shared error classifier: generalize `classify_calendar_error` → `mail::classify_google_error(e, feature: &str)` (in `mail/mod.rs`); calendar.rs delegates; drive/people use it with their feature names ("Drive", "Contacts").
- [ ] `drive.rs` fns (all take `&mut GmailSession` + `&reqwest::Client`):
  - `search(query, page_token) -> (Vec<DriveFile>, Option<String>)`: `GET https://www.googleapis.com/drive/v3/files?pageSize=30&supportsAllDrives=true&includeItemsFromAllDrives=true&fields=nextPageToken,files(id,name,mimeType,size,webViewLink,iconLink,modifiedTime,owners)`; empty query → `q=trashed = false` + `orderBy=viewedByMeTime desc`; else `q=trashed = false and (name contains '<esc>' or fullText contains '<esc>')`, no orderBy (invalid with fullText). Escape `\` and `'` in user input.
  - `file_meta(file_id) -> DriveFile` (`files/{id}?fields=...&supportsAllDrives=true`).
  - `download(file_id) -> MailAttachment`: meta first, reject size > 25 MB, then `files/{id}?alt=media` → base64.
  - `ensure_app_folder(conn-kv) -> folder_id`: kv `drive_folder:{email}` cache, verify via files.get, else find by `name = 'Fission Mail Attachments' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`, else create (files.create metadata). 
  - `upload_begin(name, mime, size, folder_id) -> session_uri`: `POST upload/drive/v3/files?uploadType=resumable&fields=id,name,webViewLink,...` body `{name, parents:[folder]}` + `X-Upload-Content-Type/Length` → `Location` header.
  - `upload_chunk(session_uri, offset, total, bytes) -> ChunkResult { done, file: Option<DriveFile> }`: PUT `Content-Range: bytes {off}-{off+len-1}/{total}`; 308 → not done; 200/201 → parse DriveFile.
  - `share(file_id, mode, emails) -> Vec<String>` (failed addresses): `POST files/{id}/permissions?supportsAllDrives=true` + `sendNotificationEmail=false` for `type=user role=reader` per address; `anyone` → single `{type: anyone, role: reader}`.
- [ ] `lib.rs`: `uploads: Mutex<HashMap<u64, DriveUpload { session_uri, account, sent, total }>>` in AppState + seq. Commands: `drive_search(query, page_token)`, `drive_download_attach(file_id)`, `drive_upload_begin(filename, mime, size) -> u64`, `drive_upload_chunk(request: tauri::ipc::Request) -> ChunkResult` (headers: `upload-id`), `drive_upload_cancel(id)`, `drive_share(file_id, mode, emails)`. All resolve the ACTIVE gmail account session; classified errors. Register all in `generate_handler!`.
- [ ] Seam: Backend gains `driveSearch(query)`, `driveDownloadAttach(fileId)`, `driveUploadFile(file: File, onProgress: (sent,total)=>void) => Promise<DriveFile>` (TauriBackend: begin + 4 MiB slice loop with raw bodies), `driveShare(fileId, mode, emails) => Promise<string[]>`.
- [ ] Mock: ~10 fixture DriveFiles (docs/sheets/pdf/images w/ names, sizes, dates); search filters by name; download → text bytes as MailAttachment; upload → setInterval ticks to 100% over ~1.5 s then a synthetic DriveFile; share → `[]`.
- [ ] Verify: `cargo check` + `npm run build`; real search/download proven through the A2 picker (A1+A2 verified together in tauri dev), upload through A3.

## Task A2: Drive picker UI

- [ ] `PickerShell`: optional `onQuery?: (q) => void` (external/async mode: skips local filter), optional `footer?: ReactNode`, `PickerItem.runAlt?: () => void` (Ctrl+Enter).
- [ ] `Picker` union + `"drivePicker"`; mount `<DrivePicker />` in App.tsx beside the others.
- [ ] `DrivePicker.tsx`: on mount `driveSearch("")` (Recents); debounced (250 ms) `onQuery` → `driveSearch(q)`; rows: type glyph (mimeType→emoji map), name, detail `size · modified`; Enter → insert chip (dispatch `fission:insert-html` + record in `compose.driveLinks`); Ctrl+Enter (files ≤ 25 MB) → `driveDownloadAttach` → append to `compose.attachments`; footer hint "↵ insert link · Ctrl+↵ attach copy". Capability-gated: no drive → single CTA row → Settings→Account.
- [ ] Entry points: 📎 buttons in Compose + ReplyDock become a 2-item flyout ("Attach files…", "Attach from Google Drive"); command `compose.attachDrive` ("Attach from Google Drive", `when: inCompose()`), default shortcut `mod+shift+d` in `defaults.ts` **and** `store/mod.rs`; `docs/SHORTCUTS.md`.
- [ ] Chip insertion listener: shells (Compose/ReplyDock) listen for `fission:insert-html` while their editor exists → `editor.chain().focus().insertContent(html).run()`.
- [ ] Verify: build + cargo check; browser demo: picker opens from flyout/command/shortcut, recents + search, chip lands in body, attach-as-copy adds attachment; tauri dev: same against real Drive.

## Task A3: oversized flow + chips + share-on-send

- [ ] `ComposeState.driveLinks: DriveLinkRef[]` (`{fileId, name, url, size?}`) — update every ComposeState literal (compose command, startReply, draft resume, mock… search `mode:` literals).
- [ ] `driveChipHtml(ref)` (ui.ts): email-safe inline-styled anchor `<a href data-drive-chip=fileId style="display:inline-block;padding:3px 10px;border:1px solid #dadce0;border-radius:8px;text-decoration:none;color:#1a73e8;background:#f8f9fa;font-size:13px">📄 name</a>` (values final in code).
- [ ] TipTap: `ChipLink = Link.extend({ addAttributes: parent + style + data-drive-chip })` in ComposeEditor (replaces `Link.configure` in both shells' extension lists).
- [ ] `htmlToText` (ui.ts): element with `data-drive-chip` → emit `\n{name} — {href}\n`, skip children.
- [ ] Settings: `driveAutoUpload: "ask"|"always"` (default ask), `driveShareMode: "recipients"|"anyone"|"none"` (default recipients) — types.rs (+serde defaults), types.ts, defaults.ts, store/mod.rs default_settings.
- [ ] Oversized interception in `addFiles`: files that would break `MAX_ATTACH_TOTAL` no longer error-break; they collect into `oversized[]`; if `driveAutoUpload === "always"` → upload directly; else ui-store prompt `drivePrompt: { files }` → modal in shells: "Too big to attach — upload to Google Drive and insert a link?" [Upload & link] [Remember choice ☐] [Cancel]. No drive capability → keep the old error message + hint to reconnect.
- [ ] Upload runner (`useComposeController`): per file — ui-store `driveUploads: {id, name, progress}[]` (pending chips rendered in the attachments strip of both shells with a progress bar); `driveUploadFile(file, onProgress)`; done → remove pending, insert real chip at caret (`fission:insert-html`), push driveLinks; failure → error toast + pending removed.
- [ ] Share-on-send (`useComposeController.send`): derive chip fileIds from the CURRENT body (`data-drive-chip` parse) ∪ driveLinks; if non-empty and real gmail account → ui-store `sharePrompt` modal: "Share with recipients (view)" (default = settings.driveShareMode) / "Anyone with the link" / "Don't change access"; remember last choice into settings. Await `driveShare(fileId, mode, to+cc+bcc)` per file (mode none → skip); failures → toast "Couldn't share with: a@b, …" and **send proceeds**. Then the existing queueMail path runs unchanged (Undo Send untouched).
- [ ] Mock: full flow works in browser (fake upload ticks, no-op share).
- [ ] Verify: build/cargo clean; browser: >25 MB file → prompt → fake progress → chip → send (mock). Real: 30 MB file → upload w/ progress → chip → send to self; existing-file chip via picker; share dialog paths; confirm the 25 MB inline gates still hold for normal attachments.

## Task A4: contacts autocomplete (People API)

- [ ] `people.rs`: `PersonRow { email, name, photo_url, source }`; `fetch_connections` (personFields=names,emailAddresses,photos, pageSize=1000, paginate), `fetch_other_contacts` (readMask=names,emailAddresses,photos), `fetch_directory` (readMask=names,emailAddresses, sources=DIRECTORY_SOURCE_TYPE_DOMAIN_PROFILE&sources=DIRECTORY_SOURCE_TYPE_DOMAIN_CONTACT) — directory errors → `Ok(vec![])` (consumer accounts); others classified.
- [ ] `store/mod.rs`: `people_contacts` table `(account_id, source, email, display_name, photo_url, updated_at, PK(account_id, source, email))`; `replace_people(conn, account, source, rows)`; `search_people(conn, account, q, limit)`.
- [ ] `search_contacts` merge (Rust): history hits (existing query, limit 8) + people hits (limit 16); dedup by email (history wins); order: prefix-match first, then history > contact > other > directory, then freq/recency. Return 8. `Contact` type unchanged.
- [ ] Sync triggers: `spawn_people_sync(app, email)` — called from `start_oauth`, from the 30 s loop when kv `people_synced:{email}` is >24 h old, and from new command `refresh_contacts` (register!). Gate on contacts capability; store kv timestamp on success.
- [ ] Mock: fixture "address book" contacts (5–6 named people NOT in the mail corpus) merged into mock `searchContacts` with the same ranking so the demo shows contacts-sourced suggestions.
- [ ] AccountTab: "Refresh contacts" button per gmail account (gated on capability) → `refreshContacts()` + toast.
- [ ] Verify: build/cargo; browser: typing a fixture-contact name autocompletes it. Real: type a Google-contact name not present in mail history → suggestion appears; directory skip logged (consumer account).

## Task A5: send-as read (+stretch)

- [ ] `SendAsAlias { email, display_name, is_default, verified, has_signature }` types both sides; fetch `GET gmail/v1/users/me/settings/sendAs` at connect (best-effort) → kv `sendas:{email}`; command `get_send_as(email)` (kv read; refresh if absent + capability). Register.
- [ ] Seam + mock (primary alias + one extra fixture alias).
- [ ] AccountTab: read-only "Send-as addresses" list per gmail account, default marked, signature dot.
- [ ] STRETCH (only if A0–A4 verified in tauri dev): From selector in compose shells when >1 verified alias; `OutgoingMail.from: Option<String>` validated against verified sendAs entries in `deliver_mail`; `build_rfc822` already takes `from`.
- [ ] Verify: build/cargo; AccountTab lists the account's aliases (real); mock shows fixture aliases.

## Wrap

- [ ] Fresh-context code review over the full diff; fix confirmed findings.
- [ ] Version 0.12.0 in `package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`.
- [ ] `docs/DECISIONS.md` entries (#87+): scope block + re-consent, chunked-IPC upload decision (no Channel), chip-in-body + Link-mark extension, abandoned-upload orphan note, share-on-send semantics, People API reversal of #56/#83, sendAs read.
- [ ] `docs/GOOGLE_OAUTH.md` + `docs/SHORTCUTS.md` final.
- [ ] NO tags, NO push without explicit go-ahead.

## Self-review notes
- Every ComposeState literal must gain `driveLinks: []` — grep `draftId: null` to find them all.
- `generate_handler!` gets: get_capabilities, drive_search, drive_download_attach, drive_upload_begin, drive_upload_chunk, drive_upload_cancel, drive_share, refresh_contacts, get_send_as.
- Settings defaults duplicated TS↔Rust: driveAutoUpload, driveShareMode, shortcut `compose.attachDrive`.
- Undo Send: cancelOutbox restores the saved compose (which carries driveLinks) — no regression path.
- Outbox payload unchanged (chips are body HTML; Drive uploads finish BEFORE queueMail).
