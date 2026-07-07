# Build A prompt — Google scopes + Drive attachments + contacts autocomplete

> Run in a fresh Claude Code session on **Fable 5** (effort `high`), from the repo root on latest `main`, working on a feature branch. Paste everything below the line as the message.

---

I'm building Fission Mail (this repo), a Superhuman-parity Gmail client: Tauri v2, React/TypeScript webview, Rust core — all Google I/O happens in Rust, and the browser demo runs entirely on the mock backend, so mock parity is a hard product convention. Beta users install weekly releases. This build lets the composer attach from Google Drive, automatically turns oversized local attachments into Drive share links the way Gmail does (today they just error at 25 MB), and adds real recipient autocomplete from Google Contacts — plus the one-time OAuth scope expansion and re-consent flow all of it rides on.

Read `docs/superpowers/specs/2026-07-07-google-integrations-design.md` first; it is the approved design — final scope list, UX decisions, acceptance criteria, file anchors, and the known traps (no incremental consent; CSP intentionally blocks all Google JS/iframes — never loosen it; the six-edit seam convention ending in mandatory `mock.ts` parity; `generate_handler!` registration; settings/shortcut defaults duplicated TS↔Rust; the outbox persists attachment bytes). Where the spec delegates a mechanism choice (§9 — e.g. how oversized bytes reach Rust without base64 JSON), verify the options against current Tauri v2 / Google API docs before committing to one.

Prerequisites on my side are done: Drive API + People API enabled, scopes added under Google Auth Platform → Data Access, test users present. If a fresh Connect Gmail still produces invalid_scope or 403s on Drive/People after your scope change, stop and report the exact error — that's my console configuration, not your code.

Work the phases in order — A0 scope+consent, A1 `mail/drive.rs`, A2 Drive picker, A3 oversized flow + link chips + share-on-send, A4 contacts autocomplete, A5 send-as read (its From-alias selector is a stretch goal: only if everything else is verified) — and don't start a phase until the previous one's acceptance criteria are demonstrated, not just compiling. Prove each phase with `npm run build` and `cargo check` clean, the real flow exercised in `npm run tauri dev`, and the mock path in the browser demo. Audit every progress claim against an actual command result or observed behavior; report failures and skips plainly.

Don't add features, refactor, or introduce abstractions beyond what the spec requires, and don't regress the sanitizer, CSP, or Undo Send semantics. Pause and ask only when something genuinely needs me: my Google console, a destructive action against my real account, or a real contradiction in the spec — otherwise keep going to completion.

Finish with the repo's release conventions — version bump in the three lockstep files, numbered `docs/DECISIONS.md` entries, `docs/GOOGLE_OAUTH.md` updated for the new scopes — but do not tag or push a release. Lead your final summary with what shipped and what you verified, written for me reading it cold.
