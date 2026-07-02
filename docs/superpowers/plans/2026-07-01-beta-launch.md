# ZenBox Mail — Beta Launch Implementation Plan (v0.3.0 → publishable beta)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Take ZenBox Mail from a working v0.3.0 to a beta that non-technical Gmail users on Windows can install from a link, connect in <5 min, and use daily — plus fix the 8 reported bugs and apply the provided UI design.

**Architecture:** Keep the existing seam: `src/lib/ipc.ts` (Backend interface) ⇄ `src-tauri/src/lib.rs` commands, with `src/lib/mock.ts` mirroring every new command for the browser demo. DB stays the UI's source of truth; remote mutations apply server-first. New surface: sanitized-HTML message rendering (ammonia in Rust + sandboxed iframe in React), attachment download/open/compose-attach, local drafts table, Gmail `history.list` incremental sync with pagination, tauri updater/notification/window-state plugins, a Google Calendar side panel, HTML signatures, avatars, and an onboarding flow.

**Tech Stack:** Tauri v2 (+plugins: updater, notification, window-state, process, dialog, opener), Rust (ammonia, rusqlite, reqwest), React/TS/Zustand/Tailwind v4, GitHub Actions + GitHub Releases as the update feed.

**Release train (ship + tag after each):**
- `v0.4.0` — Item 1: Distribution (updater, release CI, signing path)
- `v0.5.0` — Item 2: Real-mail robustness + bugs #1 (HTML render), #3 (attachments), #8 (threading UX)
- `v0.6.0` — Item 3: First-run + bugs #2 (Alt+N), #5 (HTML signatures), #6/#7 (avatars) + notifications + window state
- `v0.7.0` — Design pass + bug #4 (calendar side panel + Google Calendar events)
- Item 4 — docs only (`docs/GOOGle_OAUTH.md`), ships alongside v0.6/v0.7
- Item 5 — ONLY if budget remains: Outlook adapter, X selection, search operators. Otherwise defer with evidence.

**Verification:** after each numbered item, a fresh-context subagent runs the smoke-test checklist in `docs/SHORTCUTS.md` against the browser build (`npm run dev` + preview tools) and `cargo check`/`tsc`/`vite build` gates; desktop-only items (updater, notifications, window state) get a `cargo build` + config review since the desktop app can't be driven headlessly here. Findings get fixed before tagging.

---

## Task 1: Updater plugin + update-check UI (v0.4.0)

**Files:**
- Modify: `src-tauri/Cargo.toml` (add `tauri-plugin-updater`, `tauri-plugin-process`)
- Modify: `src-tauri/src/lib.rs` (register plugins)
- Modify: `src-tauri/tauri.conf.json` (updater config, `createUpdaterArtifacts`)
- Modify: `src-tauri/capabilities/default.json` (updater + process permissions)
- Modify: `package.json` (add `@tauri-apps/plugin-updater`, `@tauri-apps/plugin-process`)
- Create: `src/lib/updater.ts` (check on boot, expose state)
- Modify: `src/App.tsx` (update-available toast/banner with Restart button)

**Steps:**
- [ ] Generate updater keypair with `npx tauri signer generate` into scratchpad; commit ONLY the public key (tauri.conf.json `plugins.updater.pubkey`); private key → GH secret `TAURI_SIGNING_PRIVATE_KEY` via `gh secret set` (+ empty `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`), and save a local copy for the user under `%APPDATA%`-adjacent path with instructions.
- [ ] tauri.conf.json: `"bundle": {"createUpdaterArtifacts": true}`, `plugins.updater.endpoints = ["https://github.com/swarnavspujari/zenbox-mail/releases/latest/download/latest.json"]`, `windows.installMode = "passive"`.
- [ ] `src/lib/updater.ts`: on Tauri boot, `check()`; if update, expose `{version, downloadAndInstall, relaunch}` via a small zustand slice or callback into ui store toast.
- [ ] Register plugins in `lib.rs` builder: `.plugin(tauri_plugin_updater::Builder::new().build())` `.plugin(tauri_plugin_process::init())`.
- [ ] `npm run build` + `cargo check` pass.

## Task 2: Release CI on tags (v0.4.0)

**Files:**
- Create: `.github/workflows/release.yml`

**Steps:**
- [ ] Workflow triggers on `push: tags: ['v*']`; windows-latest; uses `tauri-apps/tauri-action@v0` with `tagName: ${{ github.ref_name }}`, `releaseName: "ZenBox Mail ${{ github.ref_name }}"`, `includeUpdaterJson: true`; env `TAURI_SIGNING_PRIVATE_KEY` / `..._PASSWORD` from secrets; optional Windows code signing env (`WINDOWS_CERTIFICATE`…) guarded so unsigned builds still succeed.
- [ ] Keep existing `build.yml` untouched (CI checks on push/PR).

## Task 3: Code-signing path documented (v0.4.0)

**Files:**
- Create: `docs/DISTRIBUTION.md`

**Steps:**
- [ ] Document: why SmartScreen flags unsigned NSIS; cheapest viable options with 2026 prices — Azure Trusted Signing (~$9.99/mo, individual devs OK'd, integrates via `trusted-signing-cli` in `bundle.windows.signCommand`), SignPath OSS (free for OSS), OV cert resellers (~$200–400/yr, hardware token now mandatory); recommendation = Azure Trusted Signing; exact tauri.conf + CI wiring for when the cert exists; interim mitigation text to send testers ("More info → Run anyway").
- [ ] Update README install section to point at Releases page.

## Task 4: Tag v0.4.0

- [ ] Bump versions (tauri.conf.json, package.json, Cargo.toml), update DECISIONS.md, commit, tag `v0.4.0`, push branch + tag. Verify release workflow goes green on GitHub (`gh run watch`); fix if red.

## Task 5: Sanitized HTML rendering (bug #1, item 2) (v0.5.0)

**Files:**
- Modify: `src-tauri/Cargo.toml` (add `ammonia`)
- Create: `src-tauri/src/mail/render.rs` (sanitize + cid rewrite)
- Modify: `src-tauri/src/lib.rs` (`get_thread` returns sanitized `body_html`; new `get_message_html` if lazy inline images needed)
- Modify: `src-tauri/tauri.conf.json` (CSP: `img-src` add `https: http: data:`; `frame-src 'self' data:` not needed for srcdoc)
- Modify: `src/features/thread/ThreadView.tsx` (render sanitized HTML in sandboxed iframe, auto-height, plain-text fallback)
- Modify: `src/lib/mock-data.ts` (add an HTML-bodied fixture so browser demo exercises the path)

**Approach:** sanitize on read (raw HTML stays in DB). ammonia allowlist: structural + table tags, `style` attribute allowed, `img` with src http(s)/data/cid, links rewritten `target=_blank rel=noopener`, strip scripts/forms/iframes. `cid:` URLs resolved against message attachments → data URIs (size-capped at ~2 MB per image, fetched+cached in `attachments.data` when the message is opened). Iframe: `sandbox="allow-same-origin allow-popups"` (no scripts), inject base CSS for dark-mode-friendly defaults, height synced from `contentDocument.body.scrollHeight`. External links open via opener plugin (intercept click in parent via iframe document listener — allowed because same-origin + no scripts inside).

## Task 6: Attachments in and out (bug #3, item 2) (v0.5.0)

**Files:**
- Modify: `src-tauri/src/store/mod.rs` (attachment `data` BLOB column migration; drafts table comes in Task 7)
- Modify: `src-tauri/src/lib.rs` (commands: `download_attachment(attachment_id) -> String path` via save dialog, `open_attachment(attachment_id)` temp+opener, both fetch bytes through GmailSession when not cached)
- Modify: `src-tauri/src/mail/gmail.rs` (`build_rfc822` → multipart/mixed with base64 parts; multipart/alternative for HTML — lands fully in Task 12)
- Modify: `src/lib/types.ts` + `src-tauri/src/types.rs` (`OutgoingMail.attachments: {filename, mimeType, dataBase64}[]`)
- Modify: `src/features/compose/Compose.tsx` (attach button + dialog plugin file pick, chips with remove, 25 MB total cap)
- Modify: `src/features/thread/ThreadView.tsx` (attachment chips clickable: open / save)
- Modify: `src/lib/mock.ts` (mirror commands)

## Task 7: Draft persistence (item 2) (v0.5.0)

**Files:**
- Modify: `src-tauri/src/store/mod.rs` (`drafts` table: id, account_id, payload JSON, updated_at)
- Modify: `src-tauri/src/lib.rs` (`save_draft`, `list_drafts`, `delete_draft`)
- Modify: `src/lib/ipc.ts`, `src/lib/mock.ts` (localStorage-backed mirror)
- Modify: `src/features/compose/Compose.tsx` (debounced autosave ~1 s; delete on send/queue; Esc-discard keeps the draft and toasts "Draft saved")
- Modify: `src/stores/ui.ts` + `src/lib/commands.ts` (G,D drafts view or drafts entry in palette; resume opens compose)

## Task 8: Incremental sync via history API + pagination (item 2) (v0.5.0)

**Files:**
- Modify: `src-tauri/src/mail/gmail.rs` (`history_list(start_history_id, page_token)`, `list_thread_ids_paged` with pageToken loop)
- Modify: `src-tauri/src/mail/sync.rs` (per-account `historyId` kv; incremental path: history.list → affected thread ids → refetch those; 404 = expired → full resync; initial backfill paginates inbox to 500 threads + done to 200)
- Modify: `src-tauri/src/store/mod.rs` (kv helpers for `history:<email>`)

**Approach:** keep the existing reconcile as the fallback ("full"), add fast path: if stored historyId, call `users.history.list(startHistoryId=…, pageToken loop)`; collect unique threadIds from messagesAdded/labelsAdded/labelsRemoved/messagesDeleted; fetch those threads; update stored historyId from the response's top-level `historyId`. Muted/snooze passes unchanged.

## Task 9: Superhuman-style threading (bug #8) (v0.5.0)

**Files:**
- Modify: `src/features/thread/ThreadView.tsx`

Collapsed older messages (header line: avatar, name, snippet, date; click to expand), last message always expanded, quoted trails ("On … wrote:", `<blockquote>` tails, `gmail_quote` divs) collapsed behind a `•••` toggle in both text and HTML modes, sticky subject header with message count.

## Task 10: Verify item 2 + tag v0.5.0

- [ ] `tsc`, `vite build`, `cargo check`; fresh-context subagent smoke run per SHORTCUTS.md checklist in browser demo; fix findings; bump versions; DECISIONS.md; commit; tag; push; watch release run.

## Task 11: Alt+1–9 account switching (bug #2) (v0.6.0)

**Files:**
- Modify: `src-tauri/src/store/mod.rs` (defaults `account.N` → `alt+N`; migration: saved value `mod+N` for `account.N` is rewritten to `alt+N` on settings read)
- Modify: `src/lib/mock.ts` defaults to match; `docs/SHORTCUTS.md` table.

## Task 12: HTML signatures with images (bug #5) (v0.6.0)

**Files:**
- Modify: `src/features/settings/SettingsScreen.tsx` (signature editor → contenteditable rich area; image insert via file pick → data URI; per-account as today)
- Modify: `src-tauri/src/mail/gmail.rs` (`build_rfc822` gains `body_html`: multipart/alternative — text/plain + text/html; nested in multipart/mixed when attachments exist; body text → HTML via escape + `<br>`, signature HTML appended after `<br><br>-- <br>`)
- Modify: `src-tauri/src/types.rs`, `src/lib/types.ts` (`OutgoingMail.bodyHtml: string | null`; `Settings.signatures` values become HTML — plain text legacy values still render)
- Modify: `src/features/compose/Compose.tsx` (signature preview block renders HTML)

## Task 13: Profile photo + sender avatars (bugs #6, #7) (v0.6.0)

**Files:**
- Modify: `src-tauri/src/mail/oauth.rs` (scopes add `openid profile` → userinfo `picture`)
- Modify: `src-tauri/src/lib.rs` (`get_profile(email)` returns cached {name, pictureBase64}; fetch on connect; `set_profile_photo` override)
- Create: `src/components/Avatar.tsx` (image → gravatar → tinted monogram fallback; used in header chip, thread messages, list rows if design calls for it)
- Modify: `src-tauri/src/store/mod.rs` (kv `profile:<email>`)
- Note: existing refresh tokens lack the new scopes — profile photo appears after reconnect; header falls back to monogram. Document in SETUP.

## Task 14: Onboarding + notifications + window state (item 3) (v0.6.0)

**Files:**
- Create: `src/features/onboarding/Onboarding.tsx` (4 steps: welcome/connect Gmail (or keep demo) → AI key (skippable) → theme pick → 30-second shortcut tour; `kv.onboarded` gates it; re-runnable from Settings)
- Modify: `src-tauri/Cargo.toml` + `lib.rs` (+`tauri-plugin-notification`, `tauri-plugin-window-state`; notify on new unread threads after sync when window unfocused; setting toggle `notifications: bool`)
- Modify: `src-tauri/capabilities/default.json` (notification permission)
- Modify: `src/App.tsx` (mount onboarding), `src/stores/settings.ts`, SettingsScreen toggle.

## Task 15: Verify item 3 + tag v0.6.0 (+ item 4 docs)

- [ ] Create `docs/GOOGLE_OAUTH.md`: publish consent screen steps; what testers see unverified ("Google hasn't verified this app" → Advanced → continue); Testing-mode 7-day refresh-token expiry vs published-unverified; 100-user cap; full verification path for `gmail.modify` (restricted scope: brand verification + CASA Tier 2 security assessment, timelines/costs) and the new `calendar.readonly`/profile scopes (sensitive, lighter review). Smoke-verify + tag v0.6.0.

## Task 16: Calendar side panel + Google Calendar (bug #4) (v0.7.0)

**Files:**
- Modify: `src-tauri/src/mail/oauth.rs` (scope add `https://www.googleapis.com/auth/calendar.readonly`)
- Create: `src-tauri/src/mail/calendar.rs` (events list for a day range via Calendar v3; token via the account's GmailSession)
- Modify: `src-tauri/src/lib.rs` (`list_events(startMs, endMs)`; mock fixtures in `mail/mock.rs` + `src/lib/mock.ts`)
- Create: `src/features/calendar/CalendarPanel.tsx` (right-hand day column per design `calfull.png`: date header w/ prev/next, hour grid, event blocks; toggle button in list header; state persisted in settings)
- Modify: `src/features/inbox/MailScreen.tsx` (Calendar button + panel slot), settings migration removing the builtin "calendar" split (custom splits untouched).

## Task 17: Design pass (v0.7.0)

**Files:** `src/styles/theme.css`, `src/App.tsx`, `src/features/inbox/MailScreen.tsx`, `src/features/thread/ThreadView.tsx`, `src/features/compose/Compose.tsx`, `src/features/palette/CommandPalette.tsx`, pickers.

Per screenshots: deeper indigo base, violet accent (#7c83ff-family), logo diamond + pill account chip with status dot in a slimmer header, tab bar with rounded count badges and active underline, list rows (violet unread dot, bold-white unread sender, star ★ amber, snooze chip, right-aligned relative time), selected-row tint, calendar panel styling, palette restyle. Verify against screenshots with preview screenshots side-by-side.

## Task 18: Verify + tag v0.7.0; item 5 budget check

- [ ] Full smoke checklist again (fresh subagent), tag v0.7.0, push, watch release.
- [ ] If budget remains: Outlook/Graph adapter, X bulk selection, `from:`/`in:` search operators — otherwise document deferral with evidence in DECISIONS.md + final report.

## Final deliverable to user

Batched action list: signing decision (Azure Trusted Signing signup), Google Cloud console steps (publish consent screen, add scopes, later verification), confirm GH secrets, install link for testers.
