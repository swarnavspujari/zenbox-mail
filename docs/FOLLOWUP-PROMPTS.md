# Follow-up build prompts — bugs broken out of the 2026-07-08 usage pass

Five of the twelve reported bugs were feature-sized (or by-design) rather than quick fixes, so
they're captured here as self-contained prompts with a recommended model + effort per task.
Each is written to be pasted into a fresh Claude Code session opened on the **v0.16 line**
(branch `claude/objective-bassi-83f668`, or `claude/v016-bugfixes` where the eight quick fixes
already landed). The eight fixed inline were: advance-after-triage, subject-selectable,
instant-reply width, responsive shell, scroll-axis lock, theme-in-palette, `1`→inbox, calendar
now-line auto-scroll.

Routing at a glance:

| Bug | Task | Model | Effort |
|-----|------|-------|--------|
| 5 | Search: full-history index + ranking + natural-language | **Fable 5** | `xhigh` | ✅ **shipped to `main` 2026-07-09** |
| 5·P4 | Search: semantic / vector tier (hybrid with bm25) | **Fable 5** | `xhigh` | prompt below |
| 6 | Remind-me natural-language parsing + timezone abbrev | **Opus 4.8** | `high` |
| 7B | Calendar event create as a side panel (not a popup) | **Opus 4.8** | `xhigh` |
| 12 | Auto Google Meet on invites with guests | **Opus 4.8** | `high` |
| 3 | "Duplicate" subject line | *(by-design — see note; optional Opus 4.8 `high`)* |

Shared setup every prompt assumes: Tauri v2 + React/TS/Vite/Zustand/Tailwind v4 front end; Rust
core in `src-tauri/src`. IPC seam is `src/lib/ipc.ts` ⇄ `src-tauri/src/lib.rs`; the browser demo
mock `src/lib/mock.ts` and Rust demo `src-tauri/src/mail/mock.rs` must mirror every new command.
`npm run dev` = browser demo (port 1420), `npm run build` = tsc + vite, `cargo check` in
`src-tauri`. Verify front-end changes in the browser demo before claiming done.

---

## Bug 5 — Search: full-history index, relevance ranking, natural-language queries

> **STATUS — shipped to `main` 2026-07-09 (Phases 1–3).** Background crawler
> (`sync.rs` `crawl_step`, kv cursor `crawl:{email}`), weighted-bm25 ranking
> (`store::search` via a MATERIALIZED CTE), and the operator-aware NL planner
> (`src-tauri/src/search.rs`, `ai::complete` + deterministic fallback) are live.
> The file/line refs in the prompt below are pre-change and kept for history.
> **Owner E2E still pending:** live crawl on a real account + AI parse with a
> keyed provider. The deferred semantic tier is now **Phase 4**, below.

**Model: Claude Fable 5 · effort `xhigh`.** This is the hardest item — a new subsystem spanning
the Rust core (SQLite/FTS5), a background full-history crawler, a ranking change, and a
natural-language query planner, with mock parity on both backends and real quota/rate-limit
concerns. It's ambiguous and long-horizon: exactly the class of work to route to Fable at high
effort. (If you'd rather de-risk incrementally, Phases 1–2 alone are Opus 4.8 `xhigh` work; the
NL planner in Phase 3 is where Fable earns its keep.)

Prompt:

> I'm improving search in Fission Mail, a Superhuman-style Tauri email client, because today it's
> slow and unreliable: the first search for anything older than the local cache spins on a live,
> blocking Gmail round-trip, and results are reverse-chronological with no relevance ranking. I
> want it to feel like Google — instant, ranked, and answerable in natural language.
>
> Today's behavior, so you don't re-derive it: local search is `store::search`
> (`src-tauri/src/store/mod.rs:1481-1520`) over an FTS5 table `mail_fts(thread_id UNINDEXED,
> subject, from_text, body)` (`mod.rs:62-67`), ordered `by t.last_date DESC LIMIT 60`, with a
> sanitizer that strips every Gmail operator. `search_all` (`src-tauri/src/lib.rs:1424-1478`) then
> does a live `list_thread_ids_paged` + per-thread `refetch_thread` for anything not local — the
> spinner in `src/features/search/SearchScreen.tsx`. Backfill is capped at 500/200/100
> (`src-tauri/src/mail/sync.rs:17-19`), so old mail is never indexed until a live search surfaces
> it one thread at a time. Body text IS already indexed for synced threads (`mod.rs:706-711`,
> `737-748`) — the indexing primitive exists; it's just never run over full history, never ranked,
> and never planned from natural language.
>
> Build it in phases, and after each phase verify against the browser demo (`npm run dev`) and, for
> the Rust core, `cargo check` and direct SQLite inspection:
> 1. Background full-history indexer: a resumable paged crawler in `sync.rs` that walks every
>    thread past the 500/200/100 caps (page via `list_thread_ids_paged`, follow `nextPageToken`),
>    fetches + FTS-indexes each, driven off a persisted cursor in the `kv` table so it resumes and
>    runs incrementally from the periodic sync loop. Throttle for Gmail quota; log what's deferred.
> 2. Relevance ranking: order `store::search` by `bm25(mail_fts)` with column weights so
>    subject/from_text outrank body, recency as tiebreaker.
> 3. Natural-language query planner: parse a query into `{people, terms, after/before}` and route —
>    person → most-recent-per-contact ranked by from/to match; time phrases ("last week", "in
>    March") → a date range on `last_date` plus `after:`/`before:` on the remote fallback; free
>    terms → FTS. Replace the operator-stripping sanitizer with an operator-aware builder. Use the
>    existing AI provider plumbing in `src-tauri/src/ai/*` for the parse, with a deterministic
>    plain-FTS fallback when it's unavailable.
>
> Mirror any new command in both mock backends (`src/lib/mock.ts`, `src-tauri/src/mail/mock.rs`) so
> the browser and Rust demos keep parity. Change only what search needs — no unrelated refactors,
> and don't design a semantic/embeddings tier now (note it as a future Phase 4 and stop there).
> Before calling a phase done, point to the tool output that proves it (a query that's now ranked,
> a crawl that resumed, a demo that still runs). If a phase is riskier than it looked, say so and
> recommend rather than pushing through. When you have enough to act, act — a recommendation, not a
> survey of options.

---

## Bug 6 — Remind-me: natural-language parsing + timezone-anchored 8 AM default

**Model: Claude Opus 4.8 · effort `high`.** Contained and front-end-only, but date parsing has
real edge cases (DST, rolling past times forward, ambiguous "aug 7"), so it's above `medium`. No
Fable-class capability needed — the spec is precise.

Important finding to save you time: the **absolute-instant anchoring you asked for already works.**
`at(hour, dayOffset)` in `src/features/pickers/SnoozePicker.tsx` builds the time in the host's
local zone at schedule time and stores an absolute epoch-ms, which flows unchanged through the
mail store, IPC, and Rust (`store::set_snoozed`), where wake comparisons are pure epoch math. So
"scheduled 8 AM EST, later in PST → fires at that same instant (5 AM PST)" is already satisfied.
What's missing is the natural-language input and the timezone label. No backend/Rust/mock changes
needed.

Prompt:

> I'm upgrading the Remind-me (snooze) picker in Fission Mail, a Superhuman-style Tauri email
> client, so it parses natural language and shows the timezone — like Superhuman's "Try: 8 am, 3
> days, aug 7". This is front-end only: the epoch-based storage and wake logic already anchor the
> absolute instant correctly, so leave the mail store, IPC, and Rust untouched.
>
> 1. Write a natural-language date parser (e.g. `src/lib/snooze-parse.ts`): query string →
>    `{ atMs, label }`. Handle bare clock times ("8 am", "3pm", "8:30" — next occurrence, rolling to
>    tomorrow if already past today), relative ("in 2 hours", "3 days", "2 weeks"), weekdays ("mon",
>    "next tuesday"), and absolute dates ("aug 7", "8/7"). For any input that omits a time, default
>    to 8 AM local. Build times with a local-anchored `Date` exactly like the existing `at()` helper
>    so the stored value stays an absolute epoch, and guarantee the result is strictly in the future
>    (the Rust core rejects past times at `src-tauri/src/lib.rs`). Intl is enough — no timezone
>    dataset; `Intl.DateTimeFormat().resolvedOptions().timeZone` for the zone.
> 2. Make `SnoozePicker.tsx` query-driven: keep the curated presets as the default list, pass
>    `onQuery` (the pattern `DrivePicker` already uses through `PickerShell`), and when the query
>    parses, prepend one dynamic item like `{ label: "8:00 AM EST — tomorrow", run: snooze(atMs) }`.
>    Set the placeholder to `Try: 8 am, 3 days, aug 7`.
> 3. Show the timezone abbrev everywhere a reminder time appears: pass `timeZoneName: "short"` to
>    the picker detail (`SnoozePicker.tsx`) and the reminders-list chip
>    (`src/features/inbox/MailScreen.tsx`), so "EST"/"PST" shows.
> 4. Add unit tests for the parser: past-time roll-forward, the 8 AM default, DST boundaries,
>    ambiguous "aug 7" resolving to the next future occurrence.
>
> Hand-roll the parser rather than adding an npm dependency. Change only the snooze flow; don't
> modify `PickerShell`'s shared behavior (reuse `onQuery` as-is). Verify in the browser demo
> (`npm run dev`): type a few phrases, confirm the previewed time and the timezone label, and set a
> short reminder end-to-end. Report the parser's behavior on the tricky inputs plainly, including
> any you chose not to support.

---

## Bug 7B — Calendar event creation as a right-side panel, not a popup

**Model: Claude Opus 4.8 · effort `xhigh`.** Full-stack in surface area but the backend already
exists on this branch (v0.16 `create_event`/`update_event`), so it's mostly a front-end
re-housing of `EventModal` into the existing right-dock pattern, plus click-to-create wiring.
`xhigh` is Opus's default for coding work of this size.

Prompt:

> I'm changing how Fission Mail (a Superhuman-style Tauri email client) creates calendar events. It
> currently opens `src/features/calendar/EventModal.tsx` as a centered `fixed inset-0` popup
> (rendered in `src/App.tsx` from `useCalendar((s) => s.modal)`). Superhuman instead slides the
> event editor into the right-hand side panel, and I want that: the same docked-aside slot the
> `ContactPanel`, `CalendarPanel`, and `ShortcutsPanel` already use.
>
> The write backend already exists on this branch — `create_event`/`update_event` in
> `src-tauri/src/mail/calendar.rs` and `lib.rs`, exposed through `src/lib/ipc.ts`, with the store
> actions in `src/stores/calendar.ts`. So don't rebuild persistence; re-house the editor:
> 1. Turn the event editor into a right-hand `<aside>` that follows the existing dock pattern
>    (`flex w-72 shrink-0 flex-col border-l …`, responsive width, driven by the `calendar.modal`
>    state that already exists) instead of `fixed inset-0`. Keep every field, the writable-calendar
>    selector, the all-day handling, guests, and the 412-conflict "Load latest" flow intact.
> 2. Make it open from the calendar the way Superhuman does: click/drag an empty slot in
>    `src/features/calendar/CalendarWeek.tsx` / `CalendarPanel.tsx` (the `openCreate` handlers and
>    the `B` = New Calendar Event shortcut already call into the store) now targets the side panel.
> 3. Apply the same responsive rules the shell just got (the panel must not overflow narrow
>    windows; center columns are `flex-1 min-w-0`, the shell row is `overflow-hidden`).
>
> Keep both demo backends in parity (`src/lib/mock.ts`, `src-tauri/src/mail/mock.rs`) — the browser
> demo must still create/edit events end-to-end, and demo accounts still surface the existing
> "create disabled for demo" path where they do today. Change only what the panel conversion needs;
> don't refactor the calendar rendering or the sync engine. Verify in the browser demo: open the
> panel from a slot click and from `B`, create an event, edit it, and hit the conflict path. Show
> the before/after with a demo run, not just a description.

---

## Bug 12 — Auto-add Google Meet to invites that have guests

**Model: Claude Opus 4.8 · effort `high`.** A ~75-line Rust + IPC + mock change with a precise
plan, but real API gotchas (unique `requestId`, don't re-request on update, async link
population, org policy), so `high`, not `medium`. This depends on the v0.16 calendar-write code —
it does not exist on `main`.

Prompt:

> I'm adding Google Meet auto-creation to Fission Mail (a Superhuman-style Tauri email client). When
> a calendar event is created with guests, Google Calendar attaches a Meet link automatically; ours
> doesn't. `hangoutLink` is already read and displayed (`parse_event` at
> `src-tauri/src/mail/calendar.rs:101`, shown in `EventPopover`), but nothing ever *requests* a Meet.
>
> The insert path omits conferencing at both layers the Google Calendar API requires, so fix both:
> 1. Add an `add_conferencing: bool` to `EventDraft` (Rust `src-tauri/src/types.rs`, with
>    `#[serde(default)]`; TS `src/lib/types.ts`). `ipc.ts` already passes the whole draft, so no IPC
>    signature change.
> 2. In `event_body` (`calendar.rs`), when `add_conferencing` is set on an insert (and the event has
>    no conferenceData yet), inject
>    `"conferenceData": { "createRequest": { "requestId": <fresh-random>, "conferenceSolutionKey": {
>    "type": "hangoutsMeet" } } }`. Generate `requestId` from the `rand` crate already in
>    `Cargo.toml` — it must be freshly random per request, never derived from the event id, or Google
>    dedupes and attaches the same conference. On update, do NOT re-send `createRequest` if a Meet
>    already exists (that 400s / duplicates).
> 3. Append `&conferenceDataVersion=1` to the insert URL in `insert_event` (and `patch_event` so
>    "add Meet on edit" works). Google silently strips `conferenceData` without this, so step 2 alone
>    is a no-op.
> 4. In `EventModal`, add an "Add Google Meet" checkbox near the Guests field, default-checked when
>    there's at least one guest; `buildDraft` sets `add_conferencing`.
> 5. Mirror it in both mock backends (`src/lib/mock.ts` currently hardcodes `hangoutLink: null`;
>    `src-tauri/src/mail/mock.rs`) — set a fake `meet.google.com` link when conferencing is requested.
>
> Tolerate a briefly-missing `hangout_link`: the create response's `conferenceData.status` can be
> "pending" with no link yet; `create_event` already runs a follow-up sync, so it converges — the UI
> must not error on the gap. Org policy can disable Meet creation (event still saves, conference
> comes back with an error status) — treat that as non-fatal. `active_gmail_cal` already gates
> create to Gmail accounts, so no per-provider branching is needed. Change only what conferencing
> needs. Verify `cargo check` and the browser demo; the real Gmail round-trip (link actually
> appears, no duplicate on edit) needs an owner E2E on a live account — call that out rather than
> claiming it verified.

---

## Bug 3 — The "duplicate" subject line (recommend: by-design / won't-fix)

**Recommendation: no code change.** The app renders the thread subject exactly once — the `<h1>`
in `src/features/thread/ThreadView.tsx`. The second copy you see is the *newsletter's own* hero
title/preheader living inside the email's HTML body, rendered in the sandboxed iframe; the Rust
sanitizer doesn't inject a subject and the parser keeps subject separate from body. For normal 1:1
mail the body doesn't repeat the subject, so the `<h1>` is the only place it appears — deleting it
(the tempting one-line "fix") would leave every ordinary email with no visible subject. So this
reads as a duplicate only on subject-echoing newsletters, and it's content the app shouldn't
rewrite.

If you still want to suppress the visual echo on newsletters, it's an **Opus 4.8 · `high`** task,
and it's a fragile heuristic — treat it as opt-in polish, not a bug fix:

> In Fission Mail's `ThreadView` (`src/features/thread/ThreadView.tsx`), the sandboxed email iframe
> (`HtmlBody`, sandbox `allow-same-origin`) sometimes begins with the newsletter's own copy of the
> subject, directly under our `<h1>` subject header, which reads as a duplicate. For the FIRST
> message only, after the iframe loads, read its same-origin `contentDocument`, find the first
> visible heading/large-text/preheader node inside `#fm-root`, normalize its text (trim, collapse
> whitespace, strip emoji) and compare to the thread subject; on a close match, set that node to
> `display:none`. Gate strictly to the first message so quoted replies are untouched. This
> manipulates untrusted email DOM, so be conservative — a false positive that hides a legitimate
> body heading is worse than the duplicate. Add fixtures (a subject-echoing newsletter and a normal
> email whose body legitimately repeats a heading) and confirm the normal email is untouched.
> Report the false-positive risk honestly; if it can't be made safe, recommend leaving it as-is.

---

## Phase 4 — Semantic / vector search (the deferred tier, now scheduled)

**Model: Claude Fable 5 · effort `xhigh`.** Genuinely hard, novel-integration, long-horizon: a
new native dependency (an embedded vector store), a local embedding runtime, a DB migration, a
background embedding backfill, and hybrid-ranking math — with mock parity on both backends. That's
route-up work. *Opus 4.8 fallback:* enable adaptive thinking, `xhigh`; it can do this but will
lean toward reasoning over spawning helper agents, so say so if you want parallel exploration.

**Branch/worktree:** build on a dedicated branch, e.g. `search-phase4-semantic` — it adds a native
crate + model weights that can destabilize the build, and Phases 1–3 owner-E2E is still open, so
keep `main` shippable. Use a **git worktree** if you want `main`'s checkout usable at the same time
(the crawl/E2E on a real account runs there); a plain branch is fine if you don't multitask.

**Runtime model routing (what Fission ships/calls — separate from the model that builds this):**
- **Embeddings → a small model shipped locally with the app** (384-dim class: all-MiniLM-L6-v2 or
  bge-small-en-v1.5, via a Rust ONNX runtime). This is the "small model to ship with Fission" worth
  bundling — an *embedding* model, not a generative one. It keeps mail on-device, works offline, and
  avoids paying an API to embed a whole mailbox. Embeddings are computed once in the background and
  cached; only the query is embedded live (one tiny CPU inference).
- **NL query parse (Phase 3, already built) → a small, fast *hosted* model** (Haiku 4.5 class, a
  small NIM model, or a `gpt-4o-mini`-equivalent) through the existing `ai::complete`, with the
  deterministic fallback already in place. **Don't** ship a local *generative* LLM — it's large and
  compute-heavy and would defeat the "fast, non-compute-heavy" goal.
- **Anthropic has no embeddings API.** If you choose the remote-embedding option instead of the
  local model, it's OpenAI (`text-embedding-3-small`) or a NIM embedding model — never Claude. An
  Anthropic key is only useful for the *parse*, not the vectors.

**Before the session, procure whichever you pick:** (a) nothing but disk, if going local — the
session downloads/bundles the weights from Hugging Face (~25–90 MB depending on quantization); or
(b) an OpenAI or NIM embedding key, if going remote. Optionally a small fast chat key for the NL
parse (Haiku/NIM/mini) — search still works without it via the deterministic fallback.

**Why not Typesense (still):** `sqlite-vec` gives the embedded vector capability Typesense would
have, without a server, a listening port, a RAM-resident duplicate of the mailbox, or the missing
native Windows binary. Typesense only becomes the right tool if Fission grows a multi-user,
server-backed dimension (team/shared-inbox search) — which it deliberately hasn't.

Prompt:

> I'm adding semantic (vector) search to Fission Mail, a Superhuman-style **local-first** Tauri
> email client (Rust core + React/TS), because lexical search alone misses meaning: "invoice"
> won't find "bill" or "receipt." Lexical already ships and works — a background full-history
> crawler indexes all mail into FTS5, and `store::search` / `store::search_planned`
> (`src-tauri/src/store/mod.rs`) rank by weighted bm25 behind a natural-language planner
> (`src-tauri/src/search.rs`, `ai::complete` with a deterministic fallback). I want semantic recall
> fused with that existing lexical ranking, fast and light enough to run entirely on a consumer
> laptop.
>
> The architecture is decided — build it, don't re-open it:
> - **Vector store: `sqlite-vec`** — the embedded, pure-C extension that statically links into the
>   `rusqlite` (`bundled`) already in the tree. No server, no daemon, no port (the reason Typesense
>   was rejected: server-only, no embedded mode, no native Windows binary). sqlite-vec IS the vector
>   tier; do not add a search server.
> - **Embeddings: a small local model shipped with the app** (384-dim class — all-MiniLM-L6-v2 or
>   bge-small-en-v1.5 — via a Rust ONNX runtime). Mail must never leave the device, search must work
>   offline, and embedding a whole mailbox through a paid API is a non-starter. Compute each
>   message's embedding once, in the background, cached in sqlite-vec; the query embedding is a
>   single small CPU inference per search. Add an optional "use a remote embedding provider" setting
>   for users who'd rather not ship weights — but note **Anthropic has no embeddings API**, so that
>   path is OpenAI (`text-embedding-3-small`) or a NIM embedding model, never Claude.
> - **Retrieval: hybrid.** Fuse the existing bm25 lexical ranking with vector cosine via Reciprocal
>   Rank Fusion, so exact-term precision and semantic recall combine rather than one replacing the
>   other.
>
> Step 0 — before writing code, verify the current landscape (don't trust versions from memory):
> confirm how to load `sqlite-vec` into `rusqlite` `bundled` today, and choose the embedding runtime
> by checking what's current and lightest — `fastembed-rs` (bundled/quantized ONNX, auto-download)
> vs `ort` vs `candle`. Report the model's on-disk size, its dimensions, and the added binary weight
> before committing to one.
>
> Then build in phases; after each, verify with `cargo check` / `cargo test`, direct SQLite
> inspection, and the browser demo (`npm run dev`):
> 1. **Vector store + migration.** Load sqlite-vec; add a `mail_vec` table keyed by message (and
>    thread) holding the embedding, guarded like the other migrations in `store::open`. Verify a
>    hand-inserted vector KNN-queries back.
> 2. **Embedding pipeline.** Embed message bodies in the background — extend the existing crawler
>    beat (`crawl_step` in `sync.rs`) and the new-mail path so it backfills existing mail and keeps
>    up incrementally, throttled and batched so it never blocks the UI. Cache in sqlite-vec keyed by
>    message id; skip already-embedded rows. Verify the embedded-row count converges to the message
>    count on a seeded DB.
> 3. **Hybrid retrieval.** In `store::search_planned`'s term route, compute the query embedding once,
>    KNN sqlite-vec, and fuse with the bm25 candidate list by Reciprocal Rank Fusion; keep the
>    people/date narrowing and the deterministic+lexical fallback fully working when the model or
>    embeddings are absent. Verify a synonym query that lexical-only misses (seed a "bill"/"receipt"
>    body, search "invoice") now surfaces it, and that plain exact-term queries don't regress.
> 4. **Mock parity.** Give `src/lib/mock.ts` (and `src-tauri/src/mail/mock.rs` where it seeds) a
>    simple semantic stand-in — a small hand-curated synonym map or precomputed vectors over the demo
>    fixtures — so the browser and Rust demos show semantic recall without the model runtime.
>
> Guardrails: comprehensive yet non-compute-heavy — small model, embeddings computed once and cached
> (never per keystroke), on-disk ANN (don't hold the whole index in RAM), one query inference per
> search. Change only what search needs; no unrelated refactors. Lexical search must degrade
> gracefully to exactly today's behavior when the model or embeddings aren't available — semantic is
> additive, never a hard dependency. If a phase turns out riskier or heavier than it looked (binary
> bloat, backfill time, ANN recall quality), say so and recommend rather than pushing through. When
> you have enough to act, act — a recommendation, not a survey.
