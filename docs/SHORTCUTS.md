# Keyboard Shortcuts

Aligned with **Superhuman v7 (Windows & Linux edition)**. `mod` = `Ctrl` on Windows/Linux, `⌘` on macOS. Everything is remappable in **Settings → Shortcuts** (formats: `e`, `mod+k`, `shift+e`, `g i` chords, `j|down` alternatives) and every action is in the `Ctrl+K` palette with its hint.

## Global

| Key | Action |
|---|---|
| `Ctrl+K` | Command palette (toggle) |
| `C` | Compose new email |
| `/` | Search |
| `Ctrl+1` … `Ctrl+9` | **Switch account** (slot = order in Settings → Account; reorder to reassign) |
| `Esc` | Back / close (palette → picker → AI bar → compose → thread → screen) |
| `Ctrl+,` | Settings |

## Go to (chords)

| Key | Action | Key | Action |
|---|---|---|---|
| `G` then `I` | Inbox / Important | `G` then `E` | Done |
| `G` then `O` | Other | `G` then `H` | Reminders |
| `G` then `S` | Starred | | |

## Triage

| Key | Action |
|---|---|
| `E` | Mark Done (archive) |
| `Shift+E` | Mark Not Done (back to inbox — in Done/Reminders) |
| `H` | Remind me / snooze… |
| `S` | Star / unstar |
| `#` | Trash (Gmail keeps it recoverable for 30 days) |
| `!` | Mark spam |
| `M` | Mute — archive now and auto-archive future replies |
| `Z` (or `Ctrl+Z`) | **Undo** the last action (done, trash, spam, mute, snooze, star, send…) |
| `U` | Mark read / unread (toggle) |
| `V` | Move to folder / label… |
| `Ctrl+U` | Unsubscribe (opens the newsletter's List-Unsubscribe link) |

## Conversations

| Key | Action |
|---|---|
| `J` / `↓`, `K` / `↑` | Next / previous conversation (follows into the open thread) |
| `Enter` | Open thread (in list) / Reply-all (in thread) |
| `R` | Reply (inserts the previewed Instant Reply if one is selected) |
| `A` | Reply all |
| `F` | Forward |
| `Tab` | Next split (in list) · preview next Instant Reply (in thread) |
| `Shift+Tab` | Previous split |
| `?` | Ask AI about this thread |

## Compose

| Key | Action |
|---|---|
| `Ctrl+J` | Write with AI (empty body: draft from prompt · existing text: edit with instruction) |
| `Ctrl+Enter` | Send — **with a 10-second Undo window (`Z`)** |
| `Ctrl+Shift+Enter` | Send & Mark Done |
| `Ctrl+Shift+L` | Send Later… (delivers even after an app restart) |
| `Ctrl+;` | Insert snippet (from Settings → Knowledge Base) |
| `Esc` | Close AI bar, then discard |

## Palette-only

- **Get Me To Zero (bulk archive)…** · **Sync Now** · **Switch to <account>** (also Ctrl+N)

Superhuman keys not yet mapped (their features land in later releases): `X` bulk selection, `G-D/T` drafts/sent views, calendar keys.

---

# Smoke-test checklist (run on Windows after each phase)

Launch `npm run app:dev`, then:

1. [ ] App opens dark, inbox lists threads, split tabs show **total** counts
2. [ ] `Ctrl+K` opens palette; typing filters; `Esc` closes; every row shows its key hint
3. [ ] `J`/`K` move selection; `Enter` opens; `Esc` returns
4. [ ] `E` archives (count drops, toast); thread appears under `G`,`E` (Done); `Shift+E` there returns it
5. [ ] `H` → "In 30 seconds (demo)"; thread appears in Reminders (`G`,`H`) and returns to inbox ~30s later, unread
6. [ ] `S` stars/unstars; `#` trashes; `U` toggles read state
7. [ ] `Tab`/`Shift+Tab` cycle splits; `G`,`O` jumps to Other; Calendar split contains the invites
8. [ ] **`Ctrl+2` switches to the second account (angel@ in demo); `Ctrl+1` back; header dropdown matches**
9. [ ] Settings → Splits → create a custom split — a new tab appears with matching threads
10. [ ] `R` replies, `A` reply-alls (recipients correct); `Ctrl+Enter` sends; `Ctrl+Shift+Enter` sends & archives
11. [ ] Settings → Account → set a signature → compose shows it; sent mail includes it
12. [ ] `C` → `Ctrl+J` → instruction → draft **streams** in; with text present `Ctrl+J` edits it
13. [ ] Open a thread → up to 3 Instant Replies; `Tab` previews; `R` inserts
14. [ ] `?` on a thread → ask a question → streamed answer
15. [ ] Archive a split to zero → celebration + streak; palette → "Get Me To Zero" works
16. [ ] `/` search finds body text instantly; `Enter` opens the hit
17. [ ] Settings → AI Providers → **Test connection** OK for each configured provider
18. [ ] Settings → Knowledge Base → add an instruction → next AI draft complies
19. [ ] Settings → Shortcuts → remap Compose to `n` → `n` composes, `c` doesn't
