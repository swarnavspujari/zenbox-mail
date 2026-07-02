//! Demo-mode fixtures: the same dataset as src/lib/mock-data.ts so the
//! desktop app is fully usable before any account is connected.
use crate::store;
use crate::types::*;
use rusqlite::Connection;

const H: i64 = 3_600_000;
const D: i64 = 24 * H;

/// Fixture events for the calendar side panel in demo mode: a plausible
/// founder's day, repeated for every day in the requested range.
pub fn demo_events(start_ms: i64, end_ms: i64) -> Vec<CalendarEvent> {
    let day_blocks: [(f64, f64, &str, Option<&str>); 5] = [
        (7.0, 8.0, "Workout", None),
        (8.5, 9.75, "Deep work — LP letter", None),
        (10.0, 11.5, "Helios Board Meeting", Some("Zoom")),
        (12.5, 13.25, "Lunch", None),
        (14.0, 14.75, "Fieldstone intro call", Some("Meet")),
    ];
    let mut events = vec![];
    // walk local midnights across the range
    let mut day_start = {
        let dt = chrono::DateTime::from_timestamp_millis(start_ms).unwrap_or_else(chrono::Utc::now);
        let local = dt.with_timezone(&chrono::Local).date_naive();
        local
            .and_hms_opt(0, 0, 0)
            .and_then(|t| t.and_local_timezone(chrono::Local).single())
            .map(|t| t.timestamp_millis())
            .unwrap_or(start_ms)
    };
    while day_start < end_ms {
        for (i, (from_h, to_h, title, location)) in day_blocks.iter().enumerate() {
            let s = day_start + (from_h * H as f64) as i64;
            let e = day_start + (to_h * H as f64) as i64;
            if e > start_ms && s < end_ms {
                events.push(CalendarEvent {
                    id: format!("demo-{day_start}-{i}"),
                    calendar: "Demo".into(),
                    color: None,
                    title: (*title).into(),
                    start_ms: s,
                    end_ms: e,
                    all_day: false,
                    location: location.map(str::to_string),
                });
            }
        }
        day_start += D;
    }
    events
}

struct SeedMsg {
    from: &'static str,
    from_name: &'static str,
    to: Vec<String>,
    cc: Vec<String>,
    age_ms: i64,
    unread: bool,
    body: &'static str,
    attachments: Vec<(&'static str, &'static str, i64, Option<&'static str>)>,
}

struct Seed {
    id: &'static str,
    subject: &'static str,
    starred: bool,
    labels: Vec<&'static str>,
    in_inbox: bool,
    account: &'static str,
    msgs: Vec<SeedMsg>,
}

const ME: &str = "you@zenbox.local";
const A1: &str = crate::store::DEMO_ACCOUNT;
const A2: &str = crate::store::DEMO_ACCOUNT_2;

pub fn seed_if_empty(conn: &Connection) -> Result<(), String> {
    let count: i64 = conn
        .query_row("SELECT COUNT(*) FROM threads", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    if count > 0 {
        return Ok(());
    }
    let now = chrono::Utc::now().timestamp_millis();

    let shortlist_txt = "Platform lead shortlist\n\nA. Former Notion platform PM — strong community chops, light on ops.\nB. Ex-Stripe, ran founder programs — my top pick; operator network, shipped internal tooling.\nC. VC platform associate, 3 yrs — cheaper, needs coaching.\nD. Founder (exited seed-stage) — wildcard, may want to build again.\n\nRecommend intro calls with B and D this week.";
    let burn_txt = "Burn notes for slide 19:\n- Gross burn $410k/mo, net $335k/mo after Helios markup fees\n- Burn multiple 1.4x (down from 2.1x in Q1)\n- Runway 19 months at current plan; 16 if we greenlight the two platform hires";

    let seeds = vec![
        Seed {
            id: "t-term-sheet",
            subject: "Term sheet — Series A close timing",
            starred: true,
            labels: vec!["IMPORTANT"],
            in_inbox: true,
            account: A1,
            msgs: vec![
                SeedMsg {
                    from: "maya@heliosrobotics.io",
                    from_name: "Maya Chen",
                    to: vec![ME.into()],
                    cc: vec!["legal@heliosrobotics.io".into()],
                    age_ms: 26 * H,
                    unread: false,
                    body: "Hi,\n\nAttached is the revised term sheet with the changes we discussed on the board pro-rata and the option pool sizing. Our counsel flagged one open item: the closing date. We'd like to target the 15th, but need your confirmation on wiring logistics before we lock it.\n\nCan you confirm by Thursday?\n\nBest,\nMaya",
                    attachments: vec![("Helios_SeriesA_TermSheet_v4.pdf", "application/pdf", 182_340, None)],
                },
                SeedMsg {
                    from: "maya@heliosrobotics.io",
                    from_name: "Maya Chen",
                    to: vec![ME.into()],
                    cc: vec![],
                    age_ms: 3 * H,
                    unread: true,
                    body: "Quick nudge on the note below — our counsel needs the go/no-go on the 15th by EOD tomorrow to hold the schedule.\n\nMaya",
                    attachments: vec![],
                },
            ],
        },
        Seed {
            id: "t-diligence",
            subject: "Diligence follow-ups from Tuesday's call",
            starred: false,
            labels: vec!["IMPORTANT"],
            in_inbox: true,
            account: A1,
            msgs: vec![SeedMsg {
                from: "dev.arora@granitecapital.com",
                from_name: "Dev Arora",
                to: vec![ME.into()],
                cc: vec![],
                age_ms: 7 * H,
                unread: true,
                body: "Following up on Tuesday — three things outstanding from our side:\n\n1. Cohort retention data past month 18\n2. The updated cap table post-SAFE conversion\n3. Reference contacts for the two enterprise pilots\n\nWe're aiming to bring this to IC on Monday, so anything you can get us by Friday helps.\n\nDev",
                attachments: vec![],
            }],
        },
        Seed {
            id: "t-board-deck",
            subject: "Q2 board deck — review draft",
            starred: false,
            labels: vec!["IMPORTANT"],
            in_inbox: true,
            account: A1,
            msgs: vec![SeedMsg {
                from: "priya@zenboxventures.com",
                from_name: "Priya Nair",
                to: vec![ME.into()],
                cc: vec![],
                age_ms: 2 * D,
                unread: false,
                body: "Draft of the Q2 board deck is attached. The open questions are on slide 14 (hiring plan) and slide 19 (the revised burn multiple). Would love your pass before I circulate to the rest of the board Sunday night.\n\nPriya",
                attachments: vec![
                    ("Q2_Board_Deck_DRAFT.pdf", "application/pdf", 2_412_800, None),
                    ("burn_notes.txt", "text/plain", 4_210, Some(burn_txt)),
                ],
            }],
        },
        Seed {
            id: "t-intro-founder",
            subject: "Intro: Lena Okafor (Fieldstone Bio) <> you",
            starred: false,
            labels: vec!["IMPORTANT"],
            in_inbox: true,
            account: A1,
            msgs: vec![
                SeedMsg {
                    from: "james@thirdactvc.com",
                    from_name: "James Whitfield",
                    to: vec![ME.into(), "lena@fieldstone.bio".into()],
                    cc: vec![],
                    age_ms: 30 * H,
                    unread: true,
                    body: "Connecting you two — Lena is building Fieldstone Bio (computational protein design for ag). Raising a seed, and given your thesis around applied bio tooling I thought this was worth your time. Lena, over to you to share the deck.\n\nJames",
                    attachments: vec![],
                },
                SeedMsg {
                    from: "lena@fieldstone.bio",
                    from_name: "Lena Okafor",
                    to: vec![ME.into()],
                    cc: vec!["james@thirdactvc.com".into()],
                    age_ms: 22 * H,
                    unread: true,
                    body: "Thanks James!\n\nGreat to meet you. Deck attached — we're raising a $3.5M seed to get our first two crop-protection candidates through greenhouse trials. Happy to find 30 minutes next week if there's mutual interest.\n\nLena",
                    attachments: vec![("Fieldstone_Seed_Deck.pdf", "application/pdf", 3_105_000, None)],
                },
            ],
        },
        Seed {
            id: "t-cal-board",
            subject: "Invitation: Helios Robotics Board Meeting @ Thu Jul 9, 2026 10:00 (PT)",
            starred: false,
            labels: vec!["CALENDAR"],
            in_inbox: true,
            account: A1,
            msgs: vec![SeedMsg {
                from: "calendar-invite@google.com",
                from_name: "Google Calendar",
                to: vec![ME.into()],
                cc: vec![],
                age_ms: 9 * H,
                unread: true,
                body: "You have been invited to: Helios Robotics Board Meeting\nWhen: Thursday, July 9, 2026 10:00 – 11:30 AM (PT)\nWhere: Zoom (link in event)\nOrganizer: maya@heliosrobotics.io\n\nAgenda: Q2 financials, Series A close, hiring plan.",
                attachments: vec![],
            }],
        },
        Seed {
            id: "t-cal-dinner",
            subject: "Invitation: Founders' Dinner — SF @ Wed Jul 15, 2026 19:00 (PT)",
            starred: false,
            labels: vec!["CALENDAR"],
            in_inbox: true,
            account: A1,
            msgs: vec![SeedMsg {
                from: "events@saastrix.com",
                from_name: "SaaStrix Events",
                to: vec![ME.into()],
                cc: vec![],
                age_ms: 3 * D,
                unread: false,
                body: "You're confirmed for the Founders' Dinner on July 15th, 7 PM at Foreign Cinema. Dress code: casual. Reply to this email with dietary restrictions.",
                attachments: vec![],
            }],
        },
        Seed {
            id: "t-newsletter-strictly",
            subject: "StrictlyVC: Andreessen's newest fund, a fintech reckoning",
            starred: false,
            labels: vec![],
            in_inbox: true,
            account: A1,
            msgs: vec![SeedMsg {
                from: "connie@strictlyvc.com",
                from_name: "StrictlyVC",
                to: vec![ME.into()],
                cc: vec![],
                age_ms: 12 * H,
                unread: true,
                body: "Top of the morning. A16z is raising its largest fund yet, per two sources... [newsletter continues]\n\nAlso today: the fintech secondaries market heats up, and a profile of the quiet giant of vertical SaaS.",
                attachments: vec![],
            }],
        },
        Seed {
            id: "t-newsletter-lenny",
            subject: "How the best PMs run discovery (Lenny's Newsletter)",
            starred: false,
            labels: vec![],
            in_inbox: true,
            account: A1,
            msgs: vec![SeedMsg {
                from: "lenny@substack.com",
                from_name: "Lenny Rachitsky",
                to: vec![ME.into()],
                cc: vec![],
                age_ms: 2 * D,
                unread: true,
                body: "This week: a deep dive on continuous discovery habits, with playbooks from PMs at Figma, Linear, and Notion... [newsletter continues]",
                attachments: vec![],
            }],
        },
        Seed {
            id: "t-github",
            subject: "[zenbox-mail] Your workflow run failed: CI on main",
            starred: false,
            labels: vec![],
            in_inbox: true,
            account: A1,
            msgs: vec![SeedMsg {
                from: "notifications@github.com",
                from_name: "GitHub",
                to: vec![ME.into()],
                cc: vec![],
                age_ms: 5 * D,
                unread: false,
                body: "CI on main failed after 2m14s.\n\nwindows-build: error LNK2019 unresolved external symbol...\n\nView the full run for details.",
                attachments: vec![],
            }],
        },
        Seed {
            id: "t-wire-receipt",
            subject: "Wire transfer confirmation — Mercury",
            starred: false,
            labels: vec![],
            in_inbox: true,
            account: A1,
            msgs: vec![SeedMsg {
                from: "no-reply@mercury.com",
                from_name: "Mercury",
                to: vec![ME.into()],
                cc: vec![],
                age_ms: 4 * D,
                unread: false,
                body: "Your outgoing wire of $250,000.00 to Helios Robotics Inc. has been sent. Reference: MRC-99418-2026. It should arrive within 1 business day.",
                attachments: vec![],
            }],
        },
        Seed {
            id: "t-lp-update",
            subject: "LP quarterly update — Fund II",
            starred: true,
            labels: vec!["IMPORTANT"],
            in_inbox: true,
            account: A1,
            msgs: vec![SeedMsg {
                from: "ops@pujarivp.com",
                from_name: "Fund Ops",
                to: vec![ME.into()],
                cc: vec![],
                age_ms: 6 * D,
                unread: false,
                body: "Reminder that the Fund II quarterly letter is due to LPs by the 10th. Draft numbers are in the data room; the TVPI moved to 1.8x with the Helios markup. Need your narrative section by Wednesday.",
                attachments: vec![],
            }],
        },
        Seed {
            id: "t-recruiting",
            subject: "Re: Platform lead role — candidate shortlist",
            starred: false,
            labels: vec![],
            in_inbox: true,
            account: A1,
            msgs: vec![SeedMsg {
                from: "sofia@talentfoundry.co",
                from_name: "Sofia Reyes",
                to: vec![ME.into()],
                cc: vec![],
                age_ms: 8 * D,
                unread: false,
                body: "Shortlist attached — four candidates, two from operator backgrounds. My top pick is candidate B (ex-Stripe, ran founder programs). Want me to set up intro calls for next week?",
                attachments: vec![("platform_lead_shortlist.txt", "text/plain", 2_900, Some(shortlist_txt))],
            }],
        },
        Seed {
            id: "t-done-saastr",
            subject: "Your SaaStr Annual ticket confirmation",
            starred: false,
            labels: vec![],
            in_inbox: false,
            account: A1,
            msgs: vec![SeedMsg {
                from: "tickets@saastrannual.com",
                from_name: "SaaStr Annual",
                to: vec![ME.into()],
                cc: vec![],
                age_ms: 12 * D,
                unread: false,
                body: "Ticket confirmed for SaaStr Annual 2026, September 9–11, San Mateo. Order #88213.",
                attachments: vec![],
            }],
        },
        // ---- second demo account (angel@) — proves Ctrl+1/2 switching ----
        Seed {
            id: "t2-safe-note",
            subject: "SAFE for Brightloop — countersigned copy",
            starred: true,
            labels: vec!["IMPORTANT"],
            in_inbox: true,
            account: A2,
            msgs: vec![SeedMsg {
                from: "theo@brightloop.dev",
                from_name: "Theo Lindqvist",
                to: vec![ME.into()],
                cc: vec![],
                age_ms: 5 * H,
                unread: true,
                body: "Countersigned SAFE attached — $50k at a $6M cap, as discussed. Wiring details are in the doc. Thanks for moving fast on this, means a lot.\n\nTheo",
                attachments: vec![("Brightloop_SAFE_countersigned.pdf", "application/pdf", 96_500, None)],
            }],
        },
        Seed {
            id: "t2-demo-day",
            subject: "You're invited: Foundry Batch 12 Demo Day",
            starred: false,
            labels: vec!["CALENDAR"],
            in_inbox: true,
            account: A2,
            msgs: vec![SeedMsg {
                from: "events@foundryaccel.com",
                from_name: "Foundry Accelerator",
                to: vec![ME.into()],
                cc: vec![],
                age_ms: 20 * H,
                unread: true,
                body: "Invitation: Foundry Batch 12 Demo Day\nWhen: July 22, 2026, 1:00 PM (PT)\nWhere: Fort Mason, SF + livestream\n\n14 companies presenting. RSVP by the 10th for in-person seats.",
                attachments: vec![],
            }],
        },
        Seed {
            id: "t2-angellist",
            subject: "Your Q2 portfolio summary is ready",
            starred: false,
            labels: vec![],
            in_inbox: true,
            account: A2,
            msgs: vec![SeedMsg {
                from: "no-reply@angellist.com",
                from_name: "AngelList",
                to: vec![ME.into()],
                cc: vec![],
                age_ms: 2 * D,
                unread: false,
                body: "Your Q2 2026 portfolio summary: 11 active investments, 2 markups this quarter (Brightloop, Corvid Security), 1 write-down. Full report in your dashboard.",
                attachments: vec![],
            }],
        },
        Seed {
            id: "t-done-memo",
            subject: "Investment memo feedback — Corvid Security",
            starred: false,
            labels: vec!["IMPORTANT"],
            in_inbox: false,
            account: A1,
            msgs: vec![SeedMsg {
                from: "priya@zenboxventures.com",
                from_name: "Priya Nair",
                to: vec![ME.into()],
                cc: vec![],
                age_ms: 15 * D,
                unread: false,
                body: "Left comments on the Corvid memo. Main pushback: the bottoms-up TAM feels generous given the ACVs we saw in diligence. Otherwise supportive — good find.",
                attachments: vec![],
            }],
        },
    ];

    for s in seeds {
        let mut participants: Vec<String> = vec![];
        let mut msgs = vec![];
        let mut unread = false;
        let mut last_date = 0i64;
        let n = s.msgs.len() as i64;
        for (i, sm) in s.msgs.iter().enumerate() {
            let date = now - sm.age_ms;
            last_date = last_date.max(date);
            unread |= sm.unread;
            let p = format!("{} <{}>", sm.from_name, sm.from);
            if !participants.contains(&p) {
                participants.push(p);
            }
            let mid = format!("{}-m{}", s.id, i + 1);
            let atts: Vec<(Attachment, Option<String>, Option<String>, Option<String>)> = sm
                .attachments
                .iter()
                .enumerate()
                .map(|(j, (name, mime, size, text))| {
                    (
                        Attachment {
                            id: format!("{mid}-a{}", j + 1),
                            message_id: mid.clone(),
                            filename: name.to_string(),
                            mime_type: mime.to_string(),
                            size_bytes: *size,
                        },
                        None,
                        None,
                        text.map(|t| t.to_string()),
                    )
                })
                .collect();
            // newsletters get a plausible List-Unsubscribe so Ctrl+U is demoable
            let unsub = if sm.from.contains("substack") || sm.from.contains("strictlyvc") {
                Some(format!("<https://unsubscribe.example.com/{}>", s.id))
            } else {
                None
            };
            msgs.push((
                Message {
                    id: mid.clone(),
                    thread_id: s.id.to_string(),
                    from: sm.from.to_string(),
                    from_name: sm.from_name.to_string(),
                    to: sm.to.clone(),
                    cc: sm.cc.clone(),
                    subject: s.subject.to_string(),
                    snippet: sm.body.chars().take(120).collect::<String>().replace('\n', " "),
                    body_text: sm.body.to_string(),
                    body_html: None,
                    date,
                    unread: sm.unread,
                    attachments: vec![],
                },
                None,
                unsub,
                atts,
            ));
        }
        let last_body = s.msgs.last().map(|m| m.body).unwrap_or("");
        let thread = Thread {
            id: s.id.to_string(),
            subject: s.subject.to_string(),
            snippet: last_body.chars().take(120).collect::<String>().replace('\n', " "),
            participants,
            message_count: n,
            last_date,
            unread,
            starred: s.starred,
            labels: s.labels.iter().map(|l| l.to_string()).collect(),
            in_inbox: s.in_inbox,
            snoozed_until: None,
        };
        store::upsert_thread(conn, s.account, &thread, &msgs)?;
    }
    Ok(())
}
