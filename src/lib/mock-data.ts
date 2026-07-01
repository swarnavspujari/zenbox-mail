// Seed fixtures for the mock backend (browser dev + demo mode before OAuth).
import type { Message, Thread } from "./types";

const H = 3600_000;
const D = 24 * H;
const now = Date.now();

interface Seed {
  thread: Omit<Thread, "snippet" | "messageCount" | "lastDate" | "participants">;
  messages: Array<
    Pick<Message, "from" | "fromName" | "to" | "cc" | "bodyText"> & {
      ageMs: number;
      unread?: boolean;
      attachments?: Array<{ filename: string; mimeType: string; sizeBytes: number }>;
    }
  >;
}

const ME = "you@zenbox.local";

const seeds: Seed[] = [
  {
    thread: {
      id: "t-term-sheet",
      subject: "Term sheet — Series A close timing",
      unread: true,
      starred: true,
      labels: ["IMPORTANT"],
      inInbox: true,
      snoozedUntil: null,
    },
    messages: [
      {
        from: "maya@heliosrobotics.io",
        fromName: "Maya Chen",
        to: [ME],
        cc: ["legal@heliosrobotics.io"],
        ageMs: 26 * H,
        bodyText:
          "Hi,\n\nAttached is the revised term sheet with the changes we discussed on the board pro-rata and the option pool sizing. Our counsel flagged one open item: the closing date. We'd like to target the 15th, but need your confirmation on wiring logistics before we lock it.\n\nCan you confirm by Thursday?\n\nBest,\nMaya",
        attachments: [
          { filename: "Helios_SeriesA_TermSheet_v4.pdf", mimeType: "application/pdf", sizeBytes: 182_340 },
        ],
      },
      {
        from: "maya@heliosrobotics.io",
        fromName: "Maya Chen",
        to: [ME],
        cc: [],
        ageMs: 3 * H,
        unread: true,
        bodyText:
          "Quick nudge on the note below — our counsel needs the go/no-go on the 15th by EOD tomorrow to hold the schedule.\n\nMaya",
      },
    ],
  },
  {
    thread: {
      id: "t-diligence",
      subject: "Diligence follow-ups from Tuesday's call",
      unread: true,
      starred: false,
      labels: ["IMPORTANT"],
      inInbox: true,
      snoozedUntil: null,
    },
    messages: [
      {
        from: "dev.arora@granitecapital.com",
        fromName: "Dev Arora",
        to: [ME],
        cc: [],
        ageMs: 7 * H,
        unread: true,
        bodyText:
          "Following up on Tuesday — three things outstanding from our side:\n\n1. Cohort retention data past month 18\n2. The updated cap table post-SAFE conversion\n3. Reference contacts for the two enterprise pilots\n\nWe're aiming to bring this to IC on Monday, so anything you can get us by Friday helps.\n\nDev",
      },
    ],
  },
  {
    thread: {
      id: "t-board-deck",
      subject: "Q2 board deck — review draft",
      unread: false,
      starred: false,
      labels: ["IMPORTANT"],
      inInbox: true,
      snoozedUntil: null,
    },
    messages: [
      {
        from: "priya@zenboxventures.com",
        fromName: "Priya Nair",
        to: [ME],
        cc: [],
        ageMs: 2 * D,
        bodyText:
          "Draft of the Q2 board deck is attached. The open questions are on slide 14 (hiring plan) and slide 19 (the revised burn multiple). Would love your pass before I circulate to the rest of the board Sunday night.\n\nPriya",
        attachments: [
          { filename: "Q2_Board_Deck_DRAFT.pdf", mimeType: "application/pdf", sizeBytes: 2_412_800 },
          { filename: "burn_notes.txt", mimeType: "text/plain", sizeBytes: 4_210 },
        ],
      },
    ],
  },
  {
    thread: {
      id: "t-intro-founder",
      subject: "Intro: Lena Okafor (Fieldstone Bio) <> you",
      unread: true,
      starred: false,
      labels: ["IMPORTANT"],
      inInbox: true,
      snoozedUntil: null,
    },
    messages: [
      {
        from: "james@thirdactvc.com",
        fromName: "James Whitfield",
        to: [ME, "lena@fieldstone.bio"],
        cc: [],
        ageMs: 30 * H,
        unread: true,
        bodyText:
          "Connecting you two — Lena is building Fieldstone Bio (computational protein design for ag). Raising a seed, and given your thesis around applied bio tooling I thought this was worth your time. Lena, over to you to share the deck.\n\nJames",
      },
      {
        from: "lena@fieldstone.bio",
        fromName: "Lena Okafor",
        to: [ME],
        cc: ["james@thirdactvc.com"],
        ageMs: 22 * H,
        unread: true,
        bodyText:
          "Thanks James!\n\nGreat to meet you. Deck attached — we're raising a $3.5M seed to get our first two crop-protection candidates through greenhouse trials. Happy to find 30 minutes next week if there's mutual interest.\n\nLena",
        attachments: [
          { filename: "Fieldstone_Seed_Deck.pdf", mimeType: "application/pdf", sizeBytes: 3_105_000 },
        ],
      },
    ],
  },
  {
    thread: {
      id: "t-cal-board",
      subject: "Invitation: Helios Robotics Board Meeting @ Thu Jul 9, 2026 10:00 (PT)",
      unread: true,
      starred: false,
      labels: ["CALENDAR"],
      inInbox: true,
      snoozedUntil: null,
    },
    messages: [
      {
        from: "calendar-invite@google.com",
        fromName: "Google Calendar",
        to: [ME],
        cc: [],
        ageMs: 9 * H,
        unread: true,
        bodyText:
          "You have been invited to: Helios Robotics Board Meeting\nWhen: Thursday, July 9, 2026 10:00 – 11:30 AM (PT)\nWhere: Zoom (link in event)\nOrganizer: maya@heliosrobotics.io\n\nAgenda: Q2 financials, Series A close, hiring plan.",
      },
    ],
  },
  {
    thread: {
      id: "t-cal-dinner",
      subject: "Invitation: Founders' Dinner — SF @ Wed Jul 15, 2026 19:00 (PT)",
      unread: false,
      starred: false,
      labels: ["CALENDAR"],
      inInbox: true,
      snoozedUntil: null,
    },
    messages: [
      {
        from: "events@saastrix.com",
        fromName: "SaaStrix Events",
        to: [ME],
        cc: [],
        ageMs: 3 * D,
        bodyText:
          "You're confirmed for the Founders' Dinner on July 15th, 7 PM at Foreign Cinema. Dress code: casual. Reply to this email with dietary restrictions.",
      },
    ],
  },
  {
    thread: {
      id: "t-newsletter-strictly",
      subject: "StrictlyVC: Andreessen's newest fund, a fintech reckoning",
      unread: true,
      starred: false,
      labels: [],
      inInbox: true,
      snoozedUntil: null,
    },
    messages: [
      {
        from: "connie@strictlyvc.com",
        fromName: "StrictlyVC",
        to: [ME],
        cc: [],
        ageMs: 12 * H,
        unread: true,
        bodyText:
          "Top of the morning. A16z is raising its largest fund yet, per two sources... [newsletter continues]\n\nAlso today: the fintech secondaries market heats up, and a profile of the quiet giant of vertical SaaS.",
      },
    ],
  },
  {
    thread: {
      id: "t-newsletter-lenny",
      subject: "How the best PMs run discovery (Lenny's Newsletter)",
      unread: true,
      starred: false,
      labels: [],
      inInbox: true,
      snoozedUntil: null,
    },
    messages: [
      {
        from: "lenny@substack.com",
        fromName: "Lenny Rachitsky",
        to: [ME],
        cc: [],
        ageMs: 2 * D,
        unread: true,
        bodyText:
          "This week: a deep dive on continuous discovery habits, with playbooks from PMs at Figma, Linear, and Notion... [newsletter continues]",
      },
    ],
  },
  {
    thread: {
      id: "t-github",
      subject: "[zenbox-mail] Your workflow run failed: CI on main",
      unread: false,
      starred: false,
      labels: [],
      inInbox: true,
      snoozedUntil: null,
    },
    messages: [
      {
        from: "notifications@github.com",
        fromName: "GitHub",
        to: [ME],
        cc: [],
        ageMs: 5 * D,
        bodyText:
          "CI on main failed after 2m14s.\n\nwindows-build: error LNK2019 unresolved external symbol...\n\nView the full run for details.",
      },
    ],
  },
  {
    thread: {
      id: "t-wire-receipt",
      subject: "Wire transfer confirmation — Mercury",
      unread: false,
      starred: false,
      labels: [],
      inInbox: true,
      snoozedUntil: null,
    },
    messages: [
      {
        from: "no-reply@mercury.com",
        fromName: "Mercury",
        to: [ME],
        cc: [],
        ageMs: 4 * D,
        bodyText:
          "Your outgoing wire of $250,000.00 to Helios Robotics Inc. has been sent. Reference: MRC-99418-2026. It should arrive within 1 business day.",
      },
    ],
  },
  {
    thread: {
      id: "t-lp-update",
      subject: "LP quarterly update — Fund II",
      unread: false,
      starred: true,
      labels: ["IMPORTANT"],
      inInbox: true,
      snoozedUntil: null,
    },
    messages: [
      {
        from: "ops@pujarivp.com",
        fromName: "Fund Ops",
        to: [ME],
        cc: [],
        ageMs: 6 * D,
        bodyText:
          "Reminder that the Fund II quarterly letter is due to LPs by the 10th. Draft numbers are in the data room; the TVPI moved to 1.8x with the Helios markup. Need your narrative section by Wednesday.",
      },
    ],
  },
  {
    thread: {
      id: "t-recruiting",
      subject: "Re: Platform lead role — candidate shortlist",
      unread: false,
      starred: false,
      labels: [],
      inInbox: true,
      snoozedUntil: null,
    },
    messages: [
      {
        from: "sofia@talentfoundry.co",
        fromName: "Sofia Reyes",
        to: [ME],
        cc: [],
        ageMs: 8 * D,
        bodyText:
          "Shortlist attached — four candidates, two from operator backgrounds. My top pick is candidate B (ex-Stripe, ran founder programs). Want me to set up intro calls for next week?",
        attachments: [
          { filename: "platform_lead_shortlist.txt", mimeType: "text/plain", sizeBytes: 2_900 },
        ],
      },
    ],
  },
];

// Older archived threads so the Done view and search have content.
const doneSeed: Seed[] = [
  {
    thread: {
      id: "t-done-saastr",
      subject: "Your SaaStr Annual ticket confirmation",
      unread: false,
      starred: false,
      labels: [],
      inInbox: false,
      snoozedUntil: null,
    },
    messages: [
      {
        from: "tickets@saastrannual.com",
        fromName: "SaaStr Annual",
        to: [ME],
        cc: [],
        ageMs: 12 * D,
        bodyText: "Ticket confirmed for SaaStr Annual 2026, September 9–11, San Mateo. Order #88213.",
      },
    ],
  },
  {
    thread: {
      id: "t-done-memo",
      subject: "Investment memo feedback — Corvid Security",
      unread: false,
      starred: false,
      labels: ["IMPORTANT"],
      inInbox: false,
      snoozedUntil: null,
    },
    messages: [
      {
        from: "priya@zenboxventures.com",
        fromName: "Priya Nair",
        to: [ME],
        cc: [],
        ageMs: 15 * D,
        bodyText:
          "Left comments on the Corvid memo. Main pushback: the bottoms-up TAM feels generous given the ACVs we saw in diligence. Otherwise supportive — good find.",
      },
    ],
  },
];

function buildMessages(seed: Seed): Message[] {
  return seed.messages.map((m, i) => ({
    id: `${seed.thread.id}-m${i + 1}`,
    threadId: seed.thread.id,
    from: m.from,
    fromName: m.fromName,
    to: m.to,
    cc: m.cc,
    subject: seed.thread.subject,
    snippet: m.bodyText.slice(0, 120).replace(/\n+/g, " "),
    bodyText: m.bodyText,
    bodyHtml: null,
    date: now - m.ageMs,
    unread: m.unread ?? false,
    attachments: (m.attachments ?? []).map((a, j) => ({
      id: `${seed.thread.id}-m${i + 1}-a${j + 1}`,
      messageId: `${seed.thread.id}-m${i + 1}`,
      filename: a.filename,
      mimeType: a.mimeType,
      sizeBytes: a.sizeBytes,
    })),
  }));
}

export function buildSeedData(): { threads: Thread[]; messages: Map<string, Message[]> } {
  const threads: Thread[] = [];
  const messages = new Map<string, Message[]>();
  for (const seed of [...seeds, ...doneSeed]) {
    const msgs = buildMessages(seed);
    messages.set(seed.thread.id, msgs);
    const last = msgs[msgs.length - 1];
    threads.push({
      ...seed.thread,
      snippet: last.snippet,
      participants: [...new Set(msgs.map((m) => `${m.fromName} <${m.from}>`))],
      messageCount: msgs.length,
      lastDate: last.date,
      unread: msgs.some((m) => m.unread),
    });
  }
  return { threads, messages };
}
