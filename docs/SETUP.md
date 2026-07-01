# Setup — Windows 11 (Linux notes at the end)

## 1. Install the toolchain (one time)

1. **Node.js 20+** — [nodejs.org](https://nodejs.org) → LTS installer.
2. **Rust (MSVC)** — [rustup.rs](https://rustup.rs) → run `rustup-init.exe`, accept defaults.
   Or: `winget install Rustlang.Rustup`
3. **Visual Studio Build Tools** (C++ workload) — required by the Rust MSVC toolchain:
   ```powershell
   winget install Microsoft.VisualStudio.2022.BuildTools --override "--quiet --wait --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
   ```
4. WebView2 runtime — preinstalled on Windows 11; otherwise [download from Microsoft](https://developer.microsoft.com/microsoft-edge/webview2/).

## 2. Build and run

```powershell
git clone https://github.com/swarnavspujari/zenbox-mail.git
cd zenbox-mail
npm install
npm run app:dev
```

The first Rust build compiles the whole dependency tree (several minutes). After that it's incremental. The app opens in **demo mode** with a mock inbox — everything works without credentials.

## 3. Create the Gmail OAuth client (one time, ~5 minutes)

ZenBox talks to Gmail directly from your machine, so you bring your own OAuth client. Nothing about this client is shared with anyone.

1. Go to [console.cloud.google.com](https://console.cloud.google.com) and sign in with any Google account (it does **not** have to be the mail account you'll connect).
2. Top bar → project selector → **New project**. Name it e.g. `zenbox-mail`, Create, and make sure it's selected.
3. **Enable the Gmail API:** ☰ menu → *APIs & Services* → *Library* → search **Gmail API** → Enable.
4. **Consent screen:** *APIs & Services* → *OAuth consent screen*.
   - User type: **External** → Create.
   - App name `ZenBox Mail`, your email for the two contact fields → Save through the remaining steps (no scopes changes needed here).
   - Under **Audience** (or *Test users*): click **Add users** and add the Gmail address you'll connect (e.g. `ssp@rubiareserve.com`). While the app is in "Testing" status, only these users can authorize — that's exactly what we want.
5. **Create the client:** *APIs & Services* → *Credentials* → **Create credentials → OAuth client ID**.
   - Application type: **Desktop app**. Name: `ZenBox Desktop`. Create.
   - Copy the **Client ID** (`…apps.googleusercontent.com`) and **Client secret**.
6. In ZenBox: **Settings → Account** → paste both → **Connect Gmail**. Your browser opens Google's consent page; approve access. You'll see a "Connected" page, and your inbox syncs in.

Notes:
- The requested scope is `gmail.modify` — read, send, archive, label. ZenBox cannot permanently delete mail or touch account settings.
- Credentials are stored in the **Windows Credential Manager**, never on disk or in the repo.
- Google shows an "unverified app" warning while your consent screen is in Testing status — that's your own app; click *Continue*.

## 4. Add more accounts

Settings → **Account** → *Add a Gmail account*. The same OAuth client serves every Gmail account — once it's stored, leave the fields blank and hit **Connect**; a browser consent opens for the new address (add it as a **Test user** on the consent screen first). Switch accounts with **Ctrl+1…9**; slots follow the order in Settings (reorder to reassign).

### Outlook (coming in v0.3)

Microsoft Graph support is scaffolded. When it lands you'll need a (free) Azure **app registration** instead of a Google OAuth client:

1. [portal.azure.com](https://portal.azure.com) → *Microsoft Entra ID* → *App registrations* → **New registration**.
2. Supported account types: *Personal Microsoft accounts and org accounts*. Redirect URI: leave blank (ZenBox uses the loopback + PKCE public-client flow — no secret needed).
3. API permissions: *Microsoft Graph → Delegated* → `Mail.ReadWrite`, `Mail.Send`, `offline_access`.
4. Copy the **Application (client) ID** into ZenBox when the Outlook option activates.

## 5. Add an AI key

Settings → **AI Providers** → paste a key for Claude, OpenAI, or NVIDIA NIM → **Save** → **Test connection**. See [AI_PROVIDERS.md](AI_PROVIDERS.md). The default provider is **NVIDIA NIM with DeepSeek v4** (`deepseek-ai/deepseek-v4-pro`); `deepseek-v4-flash` is the faster/cheaper alternative — change the model string in Settings any time.

## 6. Linux (Fedora & friends) — preview

Tauri v2 builds natively on Linux (the webview is WebKitGTK). The keyboard map already uses `Ctrl` on Linux. Status: compile-checked in CI on every push; full smoke run is on the roadmap before we call it supported.

Fedora build deps:

```bash
sudo dnf install webkit2gtk4.1-devel openssl-devel gtk3-devel librsvg2-devel libappindicator-gtk3-devel dbus-devel
# then the usual: npm install && npm run app:dev
```

Debian/Ubuntu: `libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev libssl-dev libdbus-1-dev`.
Secrets on Linux use the Secret Service (GNOME Keyring / KWallet) via the same `keyring` crate.

## 7. Troubleshooting

| Symptom | Fix |
|---|---|
| `link.exe not found` during build | Install VS Build Tools with C++ workload (step 1.3), restart the terminal |
| Blank window on `app:dev` | Make sure `npm run dev` isn't already running elsewhere on port 1420 |
| `Connect Gmail` opens no browser | Check the client ID/secret for stray whitespace; watch the app console |
| Google error `access_denied` | The connecting address isn't in the consent screen's **Test users** |
| Google error `redirect_uri_mismatch` | Client type must be **Desktop app**, not Web application |
| AI test fails 401 | Key pasted wrong or revoked; save it again |
