# DEMO — acceptance test (< 10 minutes)

Run each step in order on Windows 11. Each maps to a Definition-of-Done item.

## 0. Install or build (≈3 min first time)

**Installer:** run `Fission Mail_x64-setup.exe` from `src-tauri/target/release/bundle/nsis/` (or a release download) and launch Fission Mail from the Start Menu.

**From source:**
```powershell
npm install
npm run app:dev
```

✅ *DoD: builds and launches on Windows 11.* The app opens dark, in **demo mode** with two seeded accounts — steps 1–8 need no credentials.

## 0.5 The v0.3 triage loop (90s, no credentials)

1. `Alt+2` — switch to the angel@ demo account; `Alt+1` back.
2. `S` star a thread → `G` `S` — it's in Starred.
3. `#` trash a thread → **`Z`** — it's back. `!` spam → `Z` again.
4. `M` mutes a thread (archives + will auto-archive future replies).
5. Select the StrictlyVC newsletter → `Ctrl+U` → unsubscribe page opens.
6. `R` reply → type → `Ctrl+Enter` → toast "Sent — Z to undo" → press `Z` within 10s → the draft comes back. Send again and let it go.
7. `C` → write → `Ctrl+Shift+L` → "In 2 minutes (demo)" → it delivers itself (even if you restart in between).
8. `Ctrl+;` in compose inserts a Knowledge Base snippet.
9. Palette → "Toggle Light / Dark Theme" — the whole app re-skins.

## 1. Keyboard flow (60s)

1. `Ctrl+K` → palette opens, actions listed with key hints → type `done` → `Esc`.
2. `J` `J` `K` — selection moves. `Enter` — thread opens. `Esc` — back.
3. `E` — thread archives, "Done" toast, split count drops.
4. `H` → **In 30 seconds (demo)** → `G` `H` — it's in Reminders. (~30s later it returns to the inbox, unread.)
5. `G` `E` — Done view (the archived thread is there). `G` `I` — back.
6. `U` marks unread (dot appears). `V` → toggle a label.
7. `/` → type `wire` → `Enter` opens the Mercury thread.

✅ *DoD: `Ctrl+K`, `C`, `E`, `H`, `R`, `F`, `V`, `J/K`, `/`, `Tab`/`Shift+Tab`, `Ctrl+J`, `Esc` all listed in docs/SHORTCUTS.md and working.*

## 2. Splits (45s)

1. `Tab` / `Shift+Tab` cycles the splits (**Important / Other** out of the box); badges show **totals**, not unread. The **Calendar** button (top right) toggles the day panel.
2. Settings (`Ctrl+,`) → Splits → create `Newsletters` with `from` contains `substack` **OR** `from` contains `strictlyvc` → back (`Esc`): the new tab holds both newsletters.

✅ *DoD: default splits + custom split + total counts.*

## 3. Inbox Zero (45s)

1. `Tab` to a split → `E` everything in it (or palette → *Get Me To Zero*; one `Z` restores the whole sweep).
2. Full-screen celebration image + day streak appears. Any key dismisses.
3. Palette → *Get Me To Zero* on another split → pick a preserve option → toast reports the count.

✅ *DoD: celebration + streak + Get Me To Zero.*

## 4. AI drafting — the full loop (2–3 min, needs one key)

1. Settings → AI Providers → paste your **Claude** (or OpenAI / NIM) key → **Save** → **Test connection** → "Connected".
2. Open the *Term sheet* thread → up to **3 Instant Replies** appear → `Tab` previews → `R` inserts one → `Esc`, discard.
3. `C` → `Ctrl+J` → type *"tell Maya the 15th works and ask for wiring instructions"* → **draft streams in live**.
4. `Ctrl+J` again with the text present → *"make it half as long"* → the draft is rewritten.
5. `?` on the *Q2 board deck* thread → ask *"what changed in the burn multiple?"* → answer streams, citing the attached burn notes (attachment parsing).
6. Repeat step 1's Test connection for the other two providers if you have keys — same flow, same streaming. With no key, features degrade to a clear "add a key in Settings" message.

✅ *DoD: streaming compose for all three providers (or clear degradation), Instant Reply ×3, thread+attachment context.*

## 5. Personalization measurably changes output (60s)

1. Settings → Knowledge Base → instructions: `Always sign off with exactly "Cheers, S" and never use exclamation marks.` → Save.
2. `C` → `Ctrl+J` → *"thank Dev for the follow-ups"* → the draft signs **Cheers, S**, no `!`.
3. Remove the instruction, draft again → sign-off changes back.

✅ *DoD: personalization panel persists and measurably changes output.*

## 6. Real Gmail (2 min + one-time OAuth client)

1. Follow docs/SETUP.md §3 once → Settings → Account → paste Client ID/Secret → **Connect Gmail** → browser consent → inbox syncs (`ssp@rubiareserve.com`).
2. `E` a real thread → it's archived in Gmail (check the web UI). Reply from Gmail → the thread returns to the Fission inbox on the next sync (≤60s).
3. `R` → `Ctrl+Enter` → the reply actually sends (threaded, In-Reply-To set).

✅ *DoD: authenticate and see real inbox threads.*

## 7. Secrets hygiene (30s)

1. Windows *Credential Manager* → Windows Credentials → entries under `FissionMail` (AI keys, OAuth) — that's where everything lives.
2. Repo scan is clean:
   ```powershell
   git grep -iE "(sk-ant-|sk-proj|nvapi-|refresh_token\s*=|client_secret\s*[:=]\s*['\"])" -- ':!docs' ':!*.md'
   ```
   (no output = pass; the app data folder holds only non-secret cache/settings).

✅ *DoD: all keys/tokens in the OS keychain; nothing secret in the repo.*
