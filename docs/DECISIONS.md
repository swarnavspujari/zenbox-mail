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

## Model defaults (editable in Settings)
- **NIM (default): `deepseek-ai/deepseek-v4-pro`** @ `https://integrate.api.nvidia.com/v1` (alt: `deepseek-v4-flash`) · Claude: `claude-sonnet-5` · OpenAI: `gpt-5.2`
