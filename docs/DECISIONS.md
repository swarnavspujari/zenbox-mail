# Decisions & Assumptions

Running log of every non-default choice. Newest last.

## Stack (per spec defaults)
- **Tauri v2** (not Electron): lighter, OS-keychain access, locked-down webview, and the mobile path (iOS/Android) stays open with one codebase.
- React + TS + Vite + Zustand + **Tailwind v4** (CSS-variable tokens make dark/light a token swap; v4's Vite plugin removes the PostCSS config).
- SQLite via `rusqlite` (bundled, includes FTS5) — no external SQLite install.
- `keyring` crate → Windows Credential Manager. Chosen over `tauri-plugin-stronghold` for zero-config UX and true OS-level storage.

## Product interpretations
1. **Split counts = total conversations** in the split (not unread, not raw message count) — that's what makes a split read like a to-do list; matches Superhuman.
2. **Split matching**: first split whose rules match (settings order) claims the thread; the builtin "Other" (empty rule set) is the catch-all. Custom splits are inserted before "Other" so they win over it but not over Important/Calendar unless reordered.
3. **"Mark Done" = remove Gmail INBOX label** (archive). A reply re-adds INBOX server-side → the thread returns automatically on the next sync pass.
4. **Snooze** is local-first: archive remotely + `snoozed_until` locally; a 30s background tick returns due threads (re-adding INBOX+UNREAD remotely). A new reply wakes the thread early.
5. **Instant Reply insertion**: `Tab` previews suggestions in the thread view; `R`/`Enter` (reply / reply-all) inserts the highlighted suggestion for review. Nothing sends without an explicit `Ctrl+Enter`/Send click.
6. **`?` (Ask AI)** at P0 is thread-scoped Q&A (streams an answer grounded in the open thread + attachments). Inbox-wide Ask AI is P1 as specced.
7. **`Enter` in list opens** the conversation; in thread it's Reply-All (spec's dual meaning).
8. **Weekly streak** = `daily / 7` — consecutive zero-days roll into weeks; simplest model that matches "empty on consecutive days".
9. **Mock/demo mode**: with no account connected, both the browser build and the desktop app run on a seeded fixture inbox (same dataset in TS and Rust) so every feature is testable before credentials exist. Sent mail in demo mode appends locally.

## Technical choices
10. **DB is the UI's source of truth**; Gmail mutations are applied remotely first, then locally, so failures surface immediately and sync can't fight the UI.
11. **Sync = polling** (100 inbox + 50 recent archived threads, `historyId`-diffed) every 60s. Gmail push (Pub/Sub watch) needs a server — out of local-first scope; documented for P1 reconsideration.
12. **OAuth scope `gmail.modify`** — least privilege covering read/send/label. Not `gmail.readonly` + `gmail.send` because archive/label writes are core.
13. **AI streaming over Tauri `Channel`**; cancellation via per-request `AtomicBool` (frontend also stops listening immediately).
14. **Context budget in characters** (~4 chars/token heuristic, ≈25k tokens total). Truncation order: oldest messages' quoted trails stripped first, then oldest bodies capped, then attachment extracts capped per-file and in total. Newest message always survives intact.
15. **NIM is text-only** at P0 (vision support varies per NIM model); Claude/OpenAI get image attachments as base64 blocks. Attachment text extraction still applies to all three.
16. **.docx extraction is best-effort** (unzip → strip `document.xml` tags) per spec wording.
17. **Custom labels sync to Gmail** (name→id resolution, auto-create). Only system labels are assumed to pre-exist.
18. **Celebration images**: 4 bundled SVG landscapes ship in `public/inbox-zero/` (served from the app bundle — the spec's `assets/` folder would not be web-servable in Vite); a user folder is supported via the asset protocol, scope-limited to exactly that folder at runtime.
19. **Icons** are generated from a scripted PNG (`scripts/make-icon.mjs`) → `tauri icon`, so the repo has no unexplained binaries.
20. **Search** is FTS5 with sanitized prefix terms (alphanumerics only) — raw user input can't produce FTS syntax errors.
21. **No `.env` at runtime** — all credentials enter via the Settings UI into the keychain. `.env.example` documents what you need, nothing reads it.
22. **Repo layout deviation**: celebration assets live in `public/inbox-zero/` (not `assets/`) for bundling reasons; `tests/` holds the acceptance script pointer rather than a unit-test suite at P0 (the smoke-test checklist in SHORTCUTS.md is the verification vehicle, executed on Windows).

## v0.2 — Superhuman keymap parity, multi-account, signatures (2026-07-01)
23. **Keymap realigned to Superhuman v7 (Windows & Linux edition)** from the user-provided PDFs: added `A` reply-all, `S` star, `#` trash, `Shift+E` mark-not-done, `U` read/unread toggle, `G O` Other, `Ctrl+Shift+Enter` send-&-mark-done, `Ctrl+1-9` account switching. Superhuman keys deliberately not mapped yet (features don't exist): `!` spam, `M` mute, `X` selection, `Z` undo, `G-S/D/T` views, calendar keys — listed in SHORTCUTS.md. `?` stays Ask AI per the original spec (Superhuman uses it for shortcut help); remappable anyway.
24. **Multi-account**: threads carry `account_id`; one `GmailSession` per account keyed by email; one shared OAuth client serves all Gmail accounts; refresh tokens per account (`gmail:refresh_token:<email>`), v0.1's single-token name kept as a read fallback. Slots = list order in Settings; `Ctrl+N` switches; splits/KB/AI settings are global across accounts (per-account splits deferred until someone actually wants them).
25. **Outlook (Microsoft Graph) is scaffolded, not implemented** — provider field, UI stub, and Azure app-registration docs exist; the Graph adapter is the headline of v0.3. Building it properly (folders ↔ archive semantics, conversation threading, MIME) deserves its own release rather than a rushed appendix to this one.
26. **Trash (`#`)** uses Gmail's `threads.trash` (30-day recovery server-side); locally the thread is dropped from the cache entirely. No trash view at P0 — Gmail's web UI covers recovery; no undo yet (with Superhuman parity, `Z` undo is the natural v0.3 companion to spam/mute).
27. **Signatures are per-account** (`settings.signatures[email]`), shown as a distinct block in compose and appended between body and quote on send. Not injected into the editable body so the AI draft flow can't accidentally treat the signature as draft text.
28. **Demo mode now has two accounts** (`demo@` + `angel@zenbox.local`) so account switching is demonstrable with zero credentials, in both the browser mock and the desktop fixture DB.
29. **Default AI = NIM with `deepseek-ai/deepseek-v4-pro`** — supersedes the original config's Claude default because the user supplied a NIM key and asked for DeepSeek v4 (verified live: model listed + streaming works). Claude/OpenAI remain one radio-click away.
30. **`has_key` is computed from the keychain on every settings read**, not persisted — keys seeded or revoked outside the app (e.g. via `dev-secrets`) always display truthfully.
31. **`dev-secrets` bin** seeds/checks/deletes keychain entries for development; values pass via env var only. Added `default-run = "zenbox-mail"` so `tauri dev` still resolves.
32. **Linux (Fedora) is a declared target**: keyring grew the Secret Service backend, CI gained an ubuntu `cargo check` with WebKitGTK deps, SETUP documents Fedora/Debian packages. Full Linux smoke test gates calling it "supported".
33. **Settings merge on read**: saved settings gain new default shortcuts/providers on upgrade instead of being wiped or frozen.

## v0.3 — Undo, Undo Send/Send Later, spam/mute, starred, snippets, unsubscribe, light theme (2026-07-01)
34. **Undo (`Z`) is a frontend inverse-action stack**, not an event-sourced log: each triage action pushes its inverse (done↔not-done, trash/spam→restore, mute→unmute, snooze→inbox, star↔unstar). Local-first and honest — no fake "undo" that leaves server state changed.
35. **Trash/spam became soft-hides** (`threads.hidden` column) so undo restores instantly from the local row; server-side they use `threads.trash` / SPAM labels, and restore uses `untrash`/label-removal + INBOX re-add. Sync can't resurrect hidden threads (inbox/done queries exclude trash+spam server-side too).
36. **Undo Send = a 10-second outbox fuse.** Sends are queued in a SQLite `outbox` table and flushed by a 3s background task; `Z` inside the window reclaims the draft into compose. **Send Later** is the same mechanism with a user-picked timestamp — it survives app restarts, needs no server. Failures retry with a 5-attempt cap. Trade-off (documented): a scheduled send only leaves the machine while the app is running.
37. **Mute** = custom `Muted` label + archive; a sync pass re-archives any muted thread that resurfaces with new replies. Matches Gmail's mute semantics without server rules.
38. **Unsubscribe (`Ctrl+U`)** reads the RFC-2369 `List-Unsubscribe` header captured at sync: https targets open in the browser, mailto targets prefill a compose. No List-Unsubscribe → clear toast. One-click POST (RFC 8058) is a possible refinement.
39. **Starred view** (`G S`) lists starred threads across inbox+done for the active account. Drafts/Sent views deferred (drafts aren't synced yet; sent threads need a `q=in:sent` sync pass).
40. **Light theme** is a token-set swap on `html[data-theme]` — tuned, not inverted (deeper accents, `--on-accent` flips to white). Dark stays default per the original spec.
41. Outlook's Graph adapter moves to **v0.4** — v0.3 spent its budget on triage parity, which benefits every account type.

## v0.4 — Distribution: auto-update, release CI, signing path (2026-07-01)
42. **Updates ship via GitHub Releases + `tauri-plugin-updater`** — no server, matching local-first. `latest.json` at `releases/latest/download/` is the feed; the app checks at boot + every 4h, downloads in the background, and offers "Update ready — Restart". Updater artifacts are minisign-signed; the private key lives in `C:\Users\swarn\.zenbox-mail-keys\` and the `TAURI_SIGNING_PRIVATE_KEY` repo secret (losing it orphans every install — it must be backed up).
43. **Release CI = tag-triggered `tauri-action`** on `windows-latest`; the existing `build.yml` stays as the PR/push gate. Installers are **unsigned for now**: Authenticode via Azure Trusted Signing ($9.99/mo) is the documented path (docs/DISTRIBUTION.md) and needs an account only the user can create; CI wiring is written down, not faked.
44. **NSIS `installMode: passive`** for updates — the updater runs the new installer with a progress bar and no wizard clicks, closest to "it just updated itself".

## v0.5 — Real-mail robustness: HTML rendering, attachments, drafts, incremental sync (2026-07-01)
45. **HTML mail renders sanitized-on-read** (ammonia allowlist in `mail/render.rs`; raw HTML stays in the DB so the allowlist can evolve without resync). Rendering happens in a script-less `sandbox="allow-same-origin"` iframe on a white "paper" card — dependable for real newsletters that assume a light background; height tracks content via ResizeObserver; links open in the system browser. Remote images are allowed (tracking-pixel tradeoff, same call Superhuman makes); `cid:` inline images resolve to data: URIs, fetched once (≤2 MB) and cached in `attachments.data`.
46. **Attachments**: bytes are fetched lazily (open/save actions), cached ≤25 MB in SQLite; compose attaches via a native file input (base64 over IPC, so the restart-surviving outbox keeps working). `build_rfc822` grew multipart/mixed + multipart/alternative.
47. **Drafts are local-only** (`drafts` table, opaque JSON payload). Esc = save + toast, Discard = delete, autosave every 800ms, `G D` resumes. Gmail-side draft sync deferred — local-first covers the "don't lose my work" promise without a sync headache.
48. **Sync is history.list-first**: per-account `history:<email>` baseline in kv; incremental pass refetches only affected threads (any thread, not just the newest 100); 404 (expired id) falls back to the old reconcile pass, now paginated (inbox 500 / done 200 threads). Initial backfill of 500 threads takes a minute of sequential fetches — acceptable one-time cost, documented here instead of hidden.
49. **Threading UX**: older messages collapse to one-line headers (avatar + snippet), last + unread stay open, quoted trails (`On … wrote:`, `gmail_quote`, trailing blockquotes) hide behind `•••` in both text and HTML modes.

## v0.6 — First-run experience + reported bugs (2026-07-02)
50. **v0.5.0 was not released separately** — item-3 code was already on the branch before item-2's smoke pass finished, and tagging mid-branch would have shipped updater artifacts whose self-reported version (0.4.0) disagreed with the tag. v0.5+v0.6 ship together as v0.6.0; the release train resumes one-tag-per-item after this.
51. **Onboarding is a 4-step gate** (connect → AI key → theme → 10-key tour) on `settings.onboarded`; replayable from Settings → Appearance. Existing upgraders see it once — that's intended, it doubles as the "what's new" tour.
52. **Account switching is Alt+1–9** (user preference; Ctrl+N kept free for browser muscle memory). Saved settings that still carry the old default (mod+N) migrate on read; custom remaps survive.
53. **A beta Google OAuth client can be baked in at build time** (`ZENBOX_GMAIL_CLIENT_ID/SECRET` env → `option_env!`), so testers never open the Google console. Desktop clients can't keep secrets by design (PKCE still guards the flow; Thunderbird et al. ship theirs the same way). Keychain-pasted credentials always win. CI reads them from repo secrets; `scripts/set-oauth-secrets.ps1` pushes them from the local keychain (run once by the owner).
54. **OAuth scopes grew to `gmail.modify openid email profile calendar.readonly`** in one step so each tester consents exactly once. Accounts connected before v0.6 need a Disconnect → Connect to grant the new scopes (profile photo + calendar panel appear after reconsent).
55. **Signatures are sanitized rich HTML** (paste straight from Gmail's signature box, images inline as data: URIs, ≤500 KB per image). Plain-text signatures keep the old all-text send path; rich ones add a multipart/alternative HTML body. Sanitization happens at save AND render (pasted rich text is untrusted).
56. **Sender avatars are deterministic monograms** (hue from email); the account's own photo comes from the OpenID userinfo endpoint, cached as a data: URI, overridable in Settings. Other people's Google photos need People-API contacts scope — declined (more consent friction than the feature is worth at beta).
57. **New-mail notifications** fire from the 30s background loop for unread-in-inbox threads newer than a boot-time watermark, only while the window is unfocused; toggle in Settings → Appearance. Window size/position persists via tauri-plugin-window-state.
58. **Vite ignores `src-tauri/**`** — Rust saves no longer full-reload the webview (bit the smoke-test agent; would bite anyone running browser + Rust dev side by side).

## v0.7 — Design pass + calendar side panel (2026-07-02)
59. **Palette follows the user's design zip (violet, "04")**: base deepened to `#0b0c12`, accent `#7c7ff2`/`#989bfa`, selected-row indigo `#232848`; light theme's accent re-tuned to the same family. All via the existing token contract — components didn't change color code.
60. **Header**: rotated-square logo mark + pill account chip (avatar, status dot, styled native `<select>` — custom dropdown skipped on purpose: the native one is keyboard/screen-reader correct for free).
61. **The builtin Calendar split is gone** (bug #4: "showable and hidable on the side, not a tab"). Saved settings drop it on read (custom splits untouched); its threads fall through the normal split rules. The day panel toggles via the tab-bar button, a palette command ("Toggle Calendar Panel"), and persists in `settings.calendarOpen`.
62. **Calendar panel is read-only day view** (7am–8pm grid, event blocks, now-line, prev/next/today) fed by `list_events` — Google Calendar for connected accounts, fixtures in demo. Week view / event creation deferred until someone asks.

## Model defaults (editable in Settings)
- **NIM (default): `deepseek-ai/deepseek-v4-pro`** @ `https://integrate.api.nvidia.com/v1` (alt: `deepseek-v4-flash`) · Claude: `claude-sonnet-5` · OpenAI: `gpt-5.2`
