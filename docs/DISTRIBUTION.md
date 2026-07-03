# Distribution: installers, updates, and code signing

How Fission Mail gets onto a tester's machine and stays current.

## What ships today

- Every `v*` tag triggers `.github/workflows/release.yml`, which builds the
  NSIS installer on `windows-latest` and publishes a GitHub Release with:
  - `Fission Mail_<version>_x64-setup.exe` — what testers download
  - `Fission Mail_<version>_x64-setup.exe.sig` + `latest.json` — the update feed
- The app checks `releases/latest/download/latest.json` at boot and every 4
  hours, downloads in the background, and shows **"Update ready — Restart"**
  in the header. Updater artifacts are signed with a minisign key
  (public key pinned in `tauri.conf.json`; private key lives in the
  `TAURI_SIGNING_PRIVATE_KEY` repo secret and in
  `C:\Users\swarn\.fission-mail-keys\fission_updater.key` — **back this file up;
  lose it and existing installs can never update again**).

## SmartScreen: why testers see a scary prompt

The installer is not Authenticode-signed yet. Windows SmartScreen will show
"Windows protected your PC" on first run. Testers click **More info → Run
anyway**. Include this line when you send the link:

> Windows will warn because the beta isn't code-signed yet — click
> "More info", then "Run anyway".

Unsigned + low download counts = the warning persists. Signing is the only
real fix (SmartScreen "reputation" accrues per-certificate and per-file).

## Cheapest viable signing paths (2026)

| Option | Cost | Notes |
|---|---|---|
| **Azure Trusted Signing** (recommended) | **$9.99/mo** (Basic) | Microsoft-run cloud signing. Individuals can verify with a government ID; companies need 3+ years of verifiable business history. No hardware token. Certs are short-lived and rotated automatically; SmartScreen reputation attaches to the identity, not one cert. Cancel any month. |
| SignPath.io OSS program | Free | Only if the repo qualifies as an open-source project and builds run through their infrastructure; approval takes a few weeks. |
| Classic OV certificate (Certum, Sectigo via resellers) | ~$70–125/yr (Certum "Open Source" ~€69/yr) to $200–400/yr | Since June 2023 CA/B rules force private keys onto FIPS hardware tokens or cloud HSMs — annoying for CI (needs a USB token attached to a build machine, or an HSM subscription that costs more than Trusted Signing). OV certs also start with **zero** SmartScreen reputation. |
| EV certificate | $250–700/yr | Instant SmartScreen reputation, but overkill for a beta and still HSM-bound. |

**Recommendation:** Azure Trusted Signing at $9.99/mo. It is the cheapest
path that works headlessly in GitHub Actions and removes the SmartScreen
prompt once a modest number of installs accrue reputation.

### Setting up Azure Trusted Signing (one-time, ~30 min)

1. Azure portal → create a **Trusted Signing account** (Basic, $9.99/mo),
   region East US or West Europe.
2. Complete **identity validation** (individual: government ID; usually
   minutes to a few days).
3. Create a **certificate profile** (Public Trust) under the account.
4. Create an **App registration** (service principal) with the
   *Trusted Signing Certificate Profile Signer* role on the account; note
   tenant id, client id, client secret.

### Wiring the signature into CI (when the account exists)

1. Add repo secrets `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`.
2. In `release.yml`, before the tauri-action step:

   ```yaml
   - run: cargo install trusted-signing-cli --locked
   ```

   and pass the three `AZURE_*` secrets through `env:` on the tauri-action step.
3. In `src-tauri/tauri.conf.json`:

   ```json
   "bundle": {
     "windows": {
       "signCommand": "trusted-signing-cli -e https://eus.codesigning.azure.net -a <account-name> -c <profile-name> %1"
     }
   }
   ```

   (`%1` is the file Tauri hands over; the CLI reads the `AZURE_*` env vars.)

Both the NSIS installer *and* the app binary get signed; the updater keeps
working unchanged (its minisign signature is independent of Authenticode).

## Cutting a release

```powershell
# bump "version" in src-tauri/tauri.conf.json, src-tauri/Cargo.toml, package.json
git commit -am "chore: bump version to X.Y.Z"
git tag vX.Y.Z && git push && git push --tags
```

Watch the `release` workflow; when green, the Releases page has the
installer and existing installs pick the update up within 4 hours (or at
next launch).

## What testers do (send them this)

1. Download `Fission Mail_…_x64-setup.exe` from
   <https://github.com/swarnavspujari/email-productivity-client/releases/latest>
2. Run it. If Windows warns: **More info → Run anyway** (beta is unsigned).
3. The app opens with a demo inbox. Click through the welcome flow to
   connect Gmail — a browser window asks for Google consent
   (see docs/GOOGLE_OAUTH.md for the "unverified app" screen they'll see).
