# ZenBox Mail

A **keyboard-first, AI-native desktop email client** in the spirit of Superhuman — built with Tauri v2 (Rust core + system webview), React, and your own AI keys. Local-first: your mail cache, your settings, and your API keys never leave your machine.

> **Status:** v0.1.0 — Windows 11. The same codebase targets macOS next, then iOS/Android via Tauri v2 mobile.

*(screenshots/GIFs coming — run it and hit `Ctrl+K`)*

## Features

- **Fly through email** — the keymap replicates **Superhuman v7 (Windows/Linux)**: `E` done, `Shift+E` not done, `R`/`A` reply/reply-all, `S` star, `#` trash, `!` spam, `M` mute, `H` remind, `U` read/unread, `Z` **undo anything**, `Ctrl+U` unsubscribe, `J/K` navigate, `G`-chords (incl. `G S` starred), `Tab` next split. A `Ctrl+K` command palette lists everything with its shortcut.
- **Undo Send & Send Later** — every send has a 10-second `Z` window; `Ctrl+Shift+L` schedules for later. The outbox lives in SQLite, so scheduled mail survives restarts — no server involved.
- **Multiple accounts, instant switching** — connect several Gmail accounts (one shared OAuth client) and jump between inboxes with `Ctrl+1…9`; slots are reassignable by reordering in Settings. Per-account signatures. Outlook (Microsoft Graph) is scaffolded for v0.3.
- **Split Inbox** — Important / Other / Calendar out of the box, plus custom splits from `from:` / `to:` / `subject:` / label rules (AND/OR). Counts show **total** conversations, so a split reads like a to-do list.
- **Inbox Zero, celebrated** — hit zero in a split and get a full-screen celebration image with your daily/weekly streak. **Get Me To Zero** bulk-archives old mail (preserving unread/starred if you want) so the first cleanup takes seconds.
- **Write with AI (`Ctrl+J`)** — drafts stream in from **Claude, OpenAI, or NVIDIA NIM** using *your* key. The model sees the full thread, parsed attachments (PDF, text, best-effort .docx, images to multimodal models), and your personal Knowledge Base — so drafts sound like you and are grounded in real context.
- **Instant Reply** — up to 3 suggested replies per thread; `Tab` previews, `R` inserts. Nothing ever sends without your explicit review.
- **Ask AI (`?`)** — ask questions about the open thread, answered from its content.
- **Sound like me** — standing instructions, reusable snippets, and pasted voice examples persist locally and shape every draft.
- **Private by design** — OAuth tokens and AI keys live in the Windows Credential Manager (OS keychain). All secret-bearing calls happen in the Rust core, never the webview. No telemetry. No servers.
- **Dark theme done right** — layered surfaces, no pure black/white, deepened accents, WCAG AA contrast, visible focus rings.

## Requirements

- Windows 11 (10 should work; untested)
- [Node.js](https://nodejs.org) 20+ and npm
- [Rust](https://rustup.rs) (stable, MSVC toolchain) + Visual Studio Build Tools with the C++ workload
- WebView2 runtime (preinstalled on Windows 11)

## Run it

```powershell
git clone https://github.com/swarnavspujari/zenbox-mail.git
cd zenbox-mail
npm install
npm run app:dev     # desktop app (first Rust build takes a few minutes)
```

The app starts in **demo mode** with a realistic mock inbox — every feature works before you connect anything.

Build an installer:

```powershell
npm run app:build   # NSIS installer in src-tauri/target/release/bundle/nsis/
```

Browser-only UI dev (mock backend, instant reload): `npm run dev` → http://localhost:1420

## Connect Gmail

You need a **Google OAuth client (Desktop app)** — a 5-minute, one-time setup. Follow [docs/SETUP.md](docs/SETUP.md) step by step, then paste the Client ID + Secret into **Settings → Account** inside the app and hit *Connect Gmail*. Your browser opens for consent; tokens go straight into the OS keychain.

## Add AI keys

Settings → **AI Providers** → paste a key for any of:

| Provider | Get a key at | Notes |
|---|---|---|
| NVIDIA NIM (default) | [build.nvidia.com](https://build.nvidia.com) | DeepSeek v4 (`deepseek-ai/deepseek-v4-pro`); OpenAI-compatible, hosted or self-hosted base URL |
| Claude | [console.anthropic.com](https://console.anthropic.com) | SSE streaming via the Messages API |
| OpenAI | [platform.openai.com](https://platform.openai.com/api-keys) | Chat Completions, streaming |

Details and model configuration: [docs/AI_PROVIDERS.md](docs/AI_PROVIDERS.md). Use **Test connection** to verify. Keys are stored in the OS keychain and sent only to the provider you chose.

## Shortcut cheat sheet

| Key | Action | Key | Action |
|-----|--------|-----|--------|
| `Ctrl+K` | Command palette | `V` | Move to folder/label |
| `C` | Compose | `/` | Search |
| `E` / `Shift+E` | Mark Done / Not Done | `?` | Ask AI |
| `H` | Remind me / snooze | `Tab` | Next split · preview instant reply (in thread) |
| `R` / `A` | Reply / Reply all | `Shift+Tab` | Previous split |
| `F` | Forward | `G` then `I`/`O`/`E`/`H` | Go to Inbox / Other / Done / Reminders |
| `Enter` | Open (list) / Reply-all (thread) | `S` | Star |
| `J` / `↓`, `K` / `↑` | Next / previous conversation | `#` | Trash |
| `U` | Mark read/unread | `Ctrl+J` | Write with AI (in compose) |
| `Ctrl+1…9` | Switch account | `Ctrl+Enter` / `Ctrl+Shift+Enter` | Send / Send & Mark Done |
| `Esc` | Back / close | | |

Every shortcut is remappable in **Settings → Shortcuts**. Full list + smoke test: [docs/SHORTCUTS.md](docs/SHORTCUTS.md).

## Docs

- [docs/SETUP.md](docs/SETUP.md) — full Windows setup incl. creating the Gmail OAuth client
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — module boundaries, data flow, security model
- [docs/AI_PROVIDERS.md](docs/AI_PROVIDERS.md) — keys, models, endpoints
- [docs/SHORTCUTS.md](docs/SHORTCUTS.md) — cheat sheet + smoke-test checklist
- [docs/DECISIONS.md](docs/DECISIONS.md) — every non-default choice and assumption
- [DEMO.md](DEMO.md) — 10-minute acceptance test

## Roadmap

- **P0 (done, this release):** Gmail account + sync · keyboard-first UX + palette · split inbox with custom splits · Inbox Zero celebrations + streaks + Get Me To Zero · compose with streaming BYOK AI (Claude/OpenAI/NIM) · Instant Reply · context-aware drafting (thread + attachments + Knowledge Base) · personalization panel · dark theme · OS-keychain secrets
- **P1 (next):** auto labels · auto archive · richer snooze scheduler · Ask AI across the whole inbox · undo send · send later · unsubscribe (`Ctrl+U`) · multiple accounts · light theme · macOS build
- **P2 (documented, not built):** iOS/Android via Tauri v2 mobile · calendar day/week views · team collaboration · CRM integrations · read receipts — see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#p2-later)

## License

[MIT](LICENSE)
