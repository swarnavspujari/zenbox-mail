# Build B prompt — Google Calendar two-way sync + invites

> Run **after Build A has shipped** (it depends on the `calendar` scope granted there). Fresh Claude Code session on **Fable 5** (effort `high`; raise to `xhigh` only if the sync engine proves gnarly), from latest `main`, on a feature branch. Paste everything below the line.

---

I'm building Fission Mail (this repo), a Superhuman-parity Gmail client — Tauri v2, React/TS webview, Rust core, mandatory mock-backend parity for the browser demo. The calendar today is a read-only Google Calendar cache in SQLite. Build A already granted the full `calendar` scope. This build makes the calendar real: create, edit, and delete events with guests so invites actually send, RSVP to invite emails right from the thread view, and a syncToken-based incremental sync engine underneath — my beta users live in their calendar as much as their inbox.

Read the Build B section of `docs/superpowers/specs/2026-07-07-google-integrations-design.md` first; it is the approved design — extended event model and SQLite migration approach, per-calendar syncToken engine (410 → drop token and window-refetch; `orderBy`/`timeMin` are invalid with a syncToken), direct-call writes with `If-Match` etags and a 412 conflict flow (deliberately no offline write queue in v1), `sendUpdates` prompts for guest notifications, RSVP-from-mail via iCalUID lookup with an open-in-Google-Calendar fallback, and mock parity. Resolve the §9 open items by inspection (schema-evolution precedent in `store/mod.rs`) and verify Google Calendar API shapes against current reference docs rather than assuming.

Phases in order — B0 model+migration, B1 sync engine, B2 write commands, B3 event modal/popover UI, B4 invite detection + RSVP bar in mail — each demonstrated against its acceptance criteria before the next. Prove phases with `npm run build` and `cargo check` clean, real flows in `npm run tauri dev`, and the browser demo. The end-to-end that matters: create an event from Fission with my second account as guest and confirm the invite email arrives; RSVP and confirm the organizer sees it; edit in Google Calendar web then in Fission to hit the 412 path. Anything needing my second account's cooperation, set up the state you can and tell me exactly what to click there. Audit progress claims against actual outputs; report failures plainly.

Don't refactor or extend beyond the spec, and don't change the existing read-path behavior (list/refresh command shapes, `calendar:updated`, the 5-minute background loop) except as the spec directs. Pause only for console/config problems, destructive real-account actions, or genuine spec contradictions.

Finish with the version bump (three lockstep files), `docs/DECISIONS.md` entries, and `docs/GOOGLE_OAUTH.md` notes — no tags, no release. Lead the final summary with the outcome and the verification evidence, written for me reading it cold.
