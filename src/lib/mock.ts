// Full-featured in-browser backend. Serves the identical surface as the Rust
// core so the app is usable (and demoable) with zero credentials. State
// mutations persist to localStorage.
import type {
  Backend,
  BulkArchiveOpts,
  DraftStreamHandlers,
  MailView,
} from "./ipc";
import type {
  AccountsState,
  AiProviderId,
  CalendarEvent,
  DraftEntry,
  DraftRequest,
  KnowledgeBase,
  Message,
  OutgoingMail,
  ProfileInfo,
  SearchResult,
  Settings,
  Streaks,
  Thread,
  ThreadId,
  ZeroEvent,
} from "./types";
import { buildSeedData, DEMO_ACCOUNT, DEMO_ACCOUNT_2 } from "./mock-data";
import {
  BUNDLED_CELEBRATIONS,
  defaultKnowledgeBase,
  defaultSettings,
} from "./defaults";

const LS_KEY = "fission-mock-state-v1";

interface PersistedState {
  threadPatches: Record<
    string,
    Partial<Pick<Thread, "inInbox" | "unread" | "snoozedUntil" | "labels" | "starred">> & {
      hidden?: "trash" | "spam" | null;
    }
  >;
  trashed: string[]; // legacy hard-trash list (pre-undo); still honored
  outbox: { id: number; mail: OutgoingMail; sendAt: number }[];
  outboxSeq: number;
  drafts: DraftEntry[];
  draftSeq: number;
  profiles?: Record<string, ProfileInfo>;
  settings: Settings;
  kb: KnowledgeBase;
  streaks: Streaks;
  keys: Partial<Record<AiProviderId, string>>;
  activeAccount: string;
  accountOrder: string[];
}

function loadPersisted(): PersistedState {
  const fresh: PersistedState = {
    threadPatches: {},
    trashed: [],
    outbox: [],
    outboxSeq: 1,
    drafts: [],
    draftSeq: 1,
    settings: defaultSettings(),
    kb: defaultKnowledgeBase(),
    streaks: { daily: 0, weekly: 0, lastZeroDay: null },
    keys: {},
    activeAccount: DEMO_ACCOUNT,
    accountOrder: [DEMO_ACCOUNT, DEMO_ACCOUNT_2],
  };
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) {
      const loaded = JSON.parse(raw) as Partial<PersistedState>;
      const merged = { ...fresh, ...loaded };
      // settings gained fields across versions — merge defaults in
      merged.settings = { ...fresh.settings, ...merged.settings };
      merged.settings.shortcuts = {
        ...fresh.settings.shortcuts,
        ...merged.settings.shortcuts,
      };
      // v0.6: account switching moved mod+N → alt+N (custom remaps survive)
      for (let n = 1; n <= 9; n++) {
        if (merged.settings.shortcuts[`account.${n}`] === `mod+${n}`) {
          merged.settings.shortcuts[`account.${n}`] = `alt+${n}`;
        }
      }
      // v0.7: the builtin Calendar split became the side panel
      merged.settings.splits = merged.settings.splits.filter(
        (sp) => !(sp.builtin && sp.id === "calendar")
      );
      // v0.9: Delete/Backspace joined "#" as trash defaults
      if (merged.settings.shortcuts["thread.trash"] === "#") {
        merged.settings.shortcuts["thread.trash"] = "#|delete|backspace";
      }
      // v0.11: arrows scroll the reader / move the list cursor, leaving j/k
      if (merged.settings.shortcuts["list.next"] === "j|down") {
        merged.settings.shortcuts["list.next"] = "j";
      }
      if (merged.settings.shortcuts["list.prev"] === "k|up") {
        merged.settings.shortcuts["list.prev"] = "k";
      }
      // v0.14: Superhuman-parity keys (mirrors store/mod.rs get_settings)
      for (const [key, oldV, newV] of [
        ["thread.mute", "m", "shift+m"],
        ["thread.move", "v", "v|l"],
        ["goto.trash", "g t", "g t|g #"],
        ["calendar.toggle", "", "0"],
        ["calendar.open", "g c", "g c|2"],
        ["calendar.prevDay", "left", "left|-"],
        ["calendar.nextDay", "right", "right|="],
      ] as const) {
        if (merged.settings.shortcuts[key] === oldV) {
          merged.settings.shortcuts[key] = newV;
        }
      }
      return merged;
    }
  } catch {
    // corrupt state — start fresh
  }
  return fresh;
}

export class MockBackend implements Backend {
  private threads: Thread[];
  private messages: Map<string, Message[]>;
  private accountOf: Map<string, string>;
  private state: PersistedState;
  private listeners = new Set<() => void>();
  private calendarListeners = new Set<(error: string | null) => void>();
  private cancelFlags = new Map<number, boolean>();
  private aiSeq = 1;

  constructor() {
    const seed = buildSeedData();
    this.threads = seed.threads;
    this.messages = seed.messages;
    this.accountOf = seed.accountOf;
    this.state = loadPersisted();
    for (const t of this.threads) {
      Object.assign(t, this.state.threadPatches[t.id]);
    }
    this.threads = this.threads.filter((t) => !this.state.trashed.includes(t.id));
    // Return snoozed threads whose timer already elapsed while app was closed.
    this.wakeDueSnoozes();
    this.flushOutbox(); // sends that came due while the tab was closed
    setInterval(() => {
      this.wakeDueSnoozes();
      this.flushOutbox();
    }, 5_000);
  }

  private inActiveAccount(t: Thread): boolean {
    return (
      (this.accountOf.get(t.id) ?? this.state.activeAccount) ===
      this.state.activeAccount
    );
  }

  private hiddenOf(id: string): "trash" | "spam" | null {
    return this.state.threadPatches[id]?.hidden ?? null;
  }

  private flushOutbox() {
    const now = Date.now();
    const due = this.state.outbox.filter((o) => o.sendAt <= now);
    if (due.length === 0) return;
    this.state.outbox = this.state.outbox.filter((o) => o.sendAt > now);
    for (const o of due) this.deliverNow(o.mail);
    this.persist();
    this.notify();
  }

  private persist() {
    localStorage.setItem(LS_KEY, JSON.stringify(this.state));
  }

  private patch(id: ThreadId, p: PersistedState["threadPatches"][string]) {
    const t = this.threads.find((t) => t.id === id);
    if (!t) return;
    Object.assign(t, p);
    this.state.threadPatches[id] = { ...this.state.threadPatches[id], ...p };
    this.persist();
  }

  private notify() {
    for (const cb of this.listeners) cb();
  }

  private wakeDueSnoozes() {
    const now = Date.now();
    let woke = false;
    for (const t of this.threads) {
      if (t.snoozedUntil !== null && t.snoozedUntil <= now) {
        this.patch(t.id, { snoozedUntil: null, inInbox: true, unread: true });
        woke = true;
      }
    }
    if (woke) this.notify();
  }

  private accountsState(): AccountsState {
    return {
      accounts: this.state.accountOrder.map((email) => ({
        email,
        provider: "mock" as const,
        connected: true,
      })),
      active: this.state.activeAccount,
    };
  }

  async getAccounts(): Promise<AccountsState> {
    return this.accountsState();
  }
  async switchAccount(email: string): Promise<AccountsState> {
    if (this.state.accountOrder.includes(email)) {
      this.state.activeAccount = email;
      this.persist();
    }
    return this.accountsState();
  }
  async reorderAccounts(emails: string[]): Promise<AccountsState> {
    if (emails.length === this.state.accountOrder.length) {
      this.state.accountOrder = emails;
      this.persist();
    }
    return this.accountsState();
  }
  async hasGmailClient(): Promise<boolean> {
    return false;
  }
  async startOauth(): Promise<AccountsState> {
    throw new Error(
      "OAuth needs the desktop app (Rust core). The browser build runs in demo mode."
    );
  }
  async disconnect(): Promise<AccountsState> {
    return this.accountsState();
  }
  async syncNow() {
    this.wakeDueSnoozes();
  }
  async resyncAccount() {
    // demo fixtures carry real HTML already — nothing to repair
    this.wakeDueSnoozes();
  }

  async listThreads(view: MailView): Promise<Thread[]> {
    const byDate = (a: Thread, b: Thread) => b.lastDate - a.lastDate;
    if (view === "trash")
      return this.threads
        .filter((t) => this.inActiveAccount(t) && this.hiddenOf(t.id) === "trash")
        .sort(byDate);
    const mine = this.threads.filter(
      (t) => this.inActiveAccount(t) && this.hiddenOf(t.id) === null
    );
    if (view.startsWith("label:")) {
      const label = view.slice(6);
      return mine.filter((t) => t.labels.includes(label)).sort(byDate);
    }
    if (view === "inbox")
      return mine.filter((t) => t.inInbox && t.snoozedUntil === null).sort(byDate);
    if (view === "reminders")
      return mine.filter((t) => t.snoozedUntil !== null).sort(byDate);
    if (view === "starred") return mine.filter((t) => t.starred).sort(byDate);
    return mine.filter((t) => !t.inInbox && t.snoozedUntil === null).sort(byDate);
  }

  async getThread(id: ThreadId): Promise<Message[]> {
    const msgs = this.messages.get(id);
    if (!msgs) throw new Error(`unknown thread ${id}`);
    // Opening a thread marks it read (matches Gmail + the Rust core).
    for (const m of msgs) m.unread = false;
    this.patch(id, { unread: false });
    return msgs;
  }
  async refetchMessageBody(id: ThreadId): Promise<Message[]> {
    // demo fixtures always carry a body — nothing to heal
    return this.messages.get(id) ?? [];
  }

  async archiveThread(id: ThreadId) {
    this.patch(id, { inInbox: false, snoozedUntil: null });
  }
  async moveToInbox(id: ThreadId) {
    this.patch(id, { inInbox: true, snoozedUntil: null });
  }
  async hideThread(id: ThreadId, reason: "trash" | "spam") {
    this.patch(id, { hidden: reason, inInbox: false, snoozedUntil: null });
  }
  async restoreThread(id: ThreadId) {
    this.patch(id, { hidden: null, inInbox: true, snoozedUntil: null });
  }
  async muteThread(id: ThreadId) {
    const t = this.threads.find((t) => t.id === id);
    if (!t) return;
    const labels = t.labels.includes("Muted") ? t.labels : [...t.labels, "Muted"];
    this.patch(id, { labels, inInbox: false });
  }
  async unmuteThread(id: ThreadId) {
    const t = this.threads.find((t) => t.id === id);
    if (!t) return;
    this.patch(id, { labels: t.labels.filter((l) => l !== "Muted"), inInbox: true });
  }
  async unsubscribeThread(id: ThreadId) {
    const msgs = this.messages.get(id) ?? [];
    const newsletter = msgs.some(
      (m) => m.from.includes("substack") || m.from.includes("strictlyvc")
    );
    return newsletter
      ? { kind: "opened" as const, target: `https://unsubscribe.example.com/${id}` }
      : { kind: "none" as const, target: null };
  }
  async toggleStar(id: ThreadId): Promise<boolean> {
    const t = this.threads.find((t) => t.id === id);
    if (!t) return false;
    this.patch(id, { starred: !t.starred });
    return t.starred; // patched in place above
  }
  async snoozeThread(id: ThreadId, untilMs: number) {
    this.patch(id, { inInbox: false, snoozedUntil: untilMs });
  }
  async markUnread(id: ThreadId) {
    this.patch(id, { unread: true });
    const msgs = this.messages.get(id);
    if (msgs?.length) msgs[msgs.length - 1].unread = true;
  }
  async markRead(id: ThreadId) {
    this.patch(id, { unread: false });
    const msgs = this.messages.get(id);
    for (const m of msgs ?? []) m.unread = false;
  }
  async moveLabel(id: ThreadId, label: string) {
    const t = this.threads.find((t) => t.id === id);
    if (!t) return;
    const labels = t.labels.includes(label)
      ? t.labels.filter((l) => l !== label)
      : [...t.labels, label];
    this.patch(id, { labels });
  }
  async listLabels() {
    const set = new Set<string>(["IMPORTANT", "CALENDAR", "Deals", "LPs", "Personal"]);
    for (const t of this.threads) for (const l of t.labels) set.add(l);
    return [...set];
  }

  async queueMail(mail: OutgoingMail, delayMs: number): Promise<number> {
    const id = this.state.outboxSeq++;
    this.state.outbox.push({ id, mail, sendAt: Date.now() + delayMs });
    this.persist();
    setTimeout(() => this.flushOutbox(), delayMs + 100);
    return id;
  }

  async cancelOutbox(outboxId: number): Promise<OutgoingMail> {
    const entry = this.state.outbox.find((o) => o.id === outboxId);
    if (!entry) throw new Error("already sent");
    this.state.outbox = this.state.outbox.filter((o) => o.id !== outboxId);
    this.persist();
    return entry.mail;
  }

  async sendMailNow(mail: OutgoingMail): Promise<void> {
    // Undo Send off: deliver immediately, never touching the outbox.
    this.deliverNow(mail);
    this.persist();
    this.notify();
  }

  async sendOutboxNow(outboxId: number): Promise<void> {
    // Accelerate: flush a still-pending send now instead of waiting the window.
    const entry = this.state.outbox.find((o) => o.id === outboxId);
    if (!entry) throw new Error("already sent");
    this.state.outbox = this.state.outbox.filter((o) => o.id !== outboxId);
    this.deliverNow(entry.mail);
    this.persist();
    this.notify();
  }

  private deliverNow(mail: OutgoingMail) {
    const nowMs = Date.now();
    if (mail.threadId) {
      const msgs = this.messages.get(mail.threadId);
      const t = this.threads.find((t) => t.id === mail.threadId);
      if (msgs && t) {
        msgs.push({
          id: `${mail.threadId}-m${msgs.length + 1}`,
          threadId: mail.threadId,
          from: "you@fission.local",
          fromName: "You",
          to: mail.to,
          cc: mail.cc,
          subject: mail.subject,
          snippet: mail.bodyText.slice(0, 120),
          bodyText: mail.bodyText,
          bodyHtml: mail.bodyHtml,
          date: nowMs,
          unread: false,
          attachments: [],
        });
        t.messageCount = msgs.length;
        t.lastDate = nowMs;
        t.snippet = mail.bodyText.slice(0, 120);
      }
    } else {
      const id = `t-sent-${nowMs}`;
      const msg: Message = {
        id: `${id}-m1`,
        threadId: id,
        from: "you@fission.local",
        fromName: "You",
        to: mail.to,
        cc: mail.cc,
        subject: mail.subject,
        snippet: mail.bodyText.slice(0, 120),
        bodyText: mail.bodyText,
        bodyHtml: mail.bodyHtml,
        date: nowMs,
        unread: false,
        attachments: [],
      };
      this.messages.set(id, [msg]);
      this.accountOf.set(id, this.state.activeAccount);
      this.threads.push({
        id,
        subject: mail.subject,
        snippet: msg.snippet,
        participants: ["You"],
        messageCount: 1,
        lastDate: nowMs,
        unread: false,
        starred: false,
        labels: [],
        inInbox: false, // sent mail doesn't land in your own inbox
        snoozedUntil: null,
      });
    }
    this.notify();
  }

  async search(query: string): Promise<SearchResult[]> {
    const q = query.toLowerCase();
    if (!q) return [];
    const hits: SearchResult[] = [];
    for (const t of this.threads.filter((t) => this.inActiveAccount(t))) {
      const msgs = this.messages.get(t.id) ?? [];
      const hay = [
        t.subject,
        ...msgs.map((m) => `${m.fromName} ${m.from} ${m.bodyText}`),
      ]
        .join("\n")
        .toLowerCase();
      if (hay.includes(q)) {
        hits.push({
          threadId: t.id,
          subject: t.subject,
          snippet: t.snippet,
          lastDate: t.lastDate,
        });
      }
    }
    return hits.sort((a, b) => b.lastDate - a.lastDate);
  }
  // Demo has no server past the fixtures, so full-history search == local
  // search and there's nothing older to page in.
  async searchAll(query: string): Promise<SearchResult[]> {
    return this.search(query);
  }
  async loadOlder(): Promise<number> {
    return 0;
  }

  async bulkArchive(opts: BulkArchiveOpts): Promise<number> {
    const cutoff = Date.now() - opts.olderThanDays * 24 * 3600_000;
    const splits = this.state.settings.splits;
    let n = 0;
    for (const t of this.threads) {
      if (!this.inActiveAccount(t)) continue;
      if (!t.inInbox || t.snoozedUntil !== null) continue;
      if (opts.olderThanDays > 0 && t.lastDate > cutoff) continue;
      if (opts.preserveUnread && t.unread) continue;
      if (opts.preserveStarred && t.starred) continue;
      if (opts.splitId && assignSplit(t, splits) !== opts.splitId) continue;
      this.patch(t.id, { inInbox: false });
      n++;
    }
    if (n) this.notify();
    return n;
  }

  /** Demo attachments have no real bytes — serve a stand-in text file. */
  private attachmentBlob(attachmentId: string): { name: string; blob: Blob } | null {
    for (const msgs of this.messages.values()) {
      for (const m of msgs) {
        const a = m.attachments.find((a) => a.id === attachmentId);
        if (a) {
          const content = `Demo attachment: ${a.filename}\n(${a.mimeType}, ${a.sizeBytes} bytes in the fixture inbox — real bytes come from Gmail in the desktop app.)`;
          return { name: a.filename, blob: new Blob([content], { type: "text/plain" }) };
        }
      }
    }
    return null;
  }

  async downloadAttachment(attachmentId: string): Promise<string | null> {
    const att = this.attachmentBlob(attachmentId);
    if (!att) throw new Error("unknown attachment");
    const url = URL.createObjectURL(att.blob);
    const aEl = document.createElement("a");
    aEl.href = url;
    aEl.download = att.name;
    aEl.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    return att.name;
  }

  async openAttachment(attachmentId: string): Promise<void> {
    const att = this.attachmentBlob(attachmentId);
    if (!att) throw new Error("unknown attachment");
    const url = URL.createObjectURL(att.blob);
    window.open(url, "_blank");
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }

  async saveDraft(draftId: number | null, payload: string): Promise<number> {
    const now = Date.now();
    if (draftId !== null) {
      const d = this.state.drafts.find((d) => d.id === draftId);
      if (d) {
        d.payload = payload;
        d.updatedAt = now;
        this.persist();
        return draftId;
      }
    }
    const id = this.state.draftSeq++;
    this.state.drafts.push({ id, payload, updatedAt: now });
    this.persist();
    return id;
  }

  async listDrafts(): Promise<DraftEntry[]> {
    return [...this.state.drafts].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async deleteDraft(draftId: number): Promise<void> {
    this.state.drafts = this.state.drafts.filter((d) => d.id !== draftId);
    this.persist();
  }

  async getProfile(email: string): Promise<ProfileInfo | null> {
    return this.state.profiles?.[email] ?? null;
  }

  async setProfilePhoto(email: string, picture: string | null): Promise<void> {
    if (!this.state.profiles) this.state.profiles = {};
    const prof = this.state.profiles[email] ?? { name: email.split("@")[0], picture: null };
    this.state.profiles[email] = { ...prof, picture };
    this.persist();
  }

  /** Mirror of src-tauri/src/mail/mock.rs demo_events — keep in sync. */
  async listEvents(startMs: number, endMs: number): Promise<CalendarEvent[]> {
    const H = 3600_000;
    const D = 24 * H;
    const blocks: Array<[number, number, string, string | null]> = [
      [7, 8, "Workout", null],
      [8.5, 9.75, "Deep work — LP letter", null],
      [10, 11.5, "Helios Board Meeting", "Zoom"],
      [12.5, 13.25, "Lunch", null],
      [14, 14.75, "Fieldstone intro call", "Meet"],
    ];
    const events: CalendarEvent[] = [];
    let dayStart = new Date(startMs).setHours(0, 0, 0, 0);
    while (dayStart < endMs) {
      blocks.forEach(([from, to, title, location], i) => {
        const s = dayStart + from * H;
        const e = dayStart + to * H;
        if (e > startMs && s < endMs) {
          events.push({
            id: `demo-${dayStart}-${i}`,
            calendar: "Demo",
            color: null,
            title,
            startMs: s,
            endMs: e,
            allDay: false,
            location,
          });
        }
      });
      dayStart += D;
    }
    return events;
  }

  async getSettings() {
    return this.state.settings;
  }
  async saveSettings(settings: Settings) {
    this.state.settings = settings;
    this.persist();
  }
  async getKnowledgeBase() {
    return this.state.kb;
  }
  async saveKnowledgeBase(kb: KnowledgeBase) {
    this.state.kb = kb;
    this.persist();
  }

  async setAiKey(provider: AiProviderId, key: string) {
    this.state.keys[provider] = key;
    const p = this.state.settings.providers.find((p) => p.id === provider);
    if (p) p.hasKey = key.length > 0;
    this.persist();
  }
  async testAiProvider(provider: AiProviderId) {
    const key = this.state.keys[provider];
    if (!key)
      return { ok: false, message: "No key saved. Real calls need the desktop app." };
    return {
      ok: true,
      message: "Key saved (demo mode — real network test runs in the desktop app).",
    };
  }

  aiDraft(req: DraftRequest, handlers: DraftStreamHandlers): () => void {
    const id = this.aiSeq++;
    this.cancelFlags.set(id, false);
    const kb = this.state.kb;
    const thread = req.threadId ? this.threads.find((t) => t.id === req.threadId) : null;
    const msgs = req.threadId ? this.messages.get(req.threadId) ?? [] : [];
    const last = msgs[msgs.length - 1];

    let body: string;
    if (req.existingText) {
      body = `${req.existingText.trim()}\n\n[Demo edit applied: "${req.instruction}"]`;
    } else {
      const greeting = last ? `Hi ${last.fromName.split(" ")[0]},` : "Hi,";
      const ctx = thread
        ? `Thanks for the note on "${thread.subject}".`
        : "";
      const instructionLine = req.instruction
        ? `Here's a draft along the lines of: ${req.instruction}.`
        : "Happy to help — here are my thoughts.";
      const kbLine = kb.instructions
        ? `\n\n[Demo mode: your standing instructions are being applied — "${kb.instructions.slice(0, 90)}"]`
        : "";
      body = `${greeting}\n\n${ctx} ${instructionLine}\n\nLet me know if this works on your end and I'll take it from there.\n\nBest,\nDemo Draft${kbLine}`;
    }

    const words = body.split(/(?<=\s)/);
    let i = 0;
    const tick = () => {
      if (this.cancelFlags.get(id)) return;
      if (i >= words.length) {
        handlers.onDone();
        return;
      }
      handlers.onChunk(words[i]);
      i++;
      setTimeout(tick, 18);
    };
    setTimeout(tick, 250);
    return () => this.cancelFlags.set(id, true);
  }

  async aiSuggestReplies(threadId: ThreadId): Promise<string[]> {
    const msgs = this.messages.get(threadId) ?? [];
    const last = msgs[msgs.length - 1];
    const name = last ? last.fromName.split(" ")[0] : "there";
    return [
      `Thanks ${name} — confirming receipt. I'll review and come back to you by tomorrow.`,
      `Appreciate the nudge. Yes on my end — let's lock it in.`,
      `Thanks for this. A few questions before I can confirm — do you have 15 minutes this week?`,
    ];
  }

  async getStreaks() {
    return this.state.streaks;
  }

  async recordZero(splitId: string): Promise<ZeroEvent | null> {
    const today = new Date().toISOString().slice(0, 10);
    const s = this.state.streaks;
    if (s.lastZeroDay !== today) {
      const yesterday = new Date(Date.now() - 24 * 3600_000)
        .toISOString()
        .slice(0, 10);
      s.daily = s.lastZeroDay === yesterday ? s.daily + 1 : 1;
      s.weekly = Math.floor(s.daily / 7);
      s.lastZeroDay = today;
      this.persist();
    }
    const img =
      BUNDLED_CELEBRATIONS[
        Math.floor(Math.random() * BUNDLED_CELEBRATIONS.length)
      ];
    return { splitId, daily: s.daily, weekly: s.weekly, imagePath: img };
  }

  async listCelebrationImages() {
    return BUNDLED_CELEBRATIONS;
  }

  async refreshCalendar() {
    // demo events are synthesized on read — announce "fresh" immediately
    for (const cb of this.calendarListeners) cb(null);
  }

  // The Unsplash key lives in the Rust core only; the browser demo serves a
  // bundled scene so the empty-state layout is still demoable.
  async getDailyPhoto() {
    return {
      url: "/inbox-zero/quiet-lake.svg",
      blurHash: null,
      authorName: "Fission demo art",
      authorLink: null,
      photoLink: null,
      downloadLocation: null,
      cachedDataUri: null,
      fetchedAt: Date.now(),
    };
  }
  async photoShown() {}
  async setUnsplashKey() {}

  /** Recipient autocomplete from the demo corpus: everyone the active
   *  account has sent to or heard from, ranked like the Rust core. */
  async searchContacts(query: string) {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const me = this.state.activeAccount.toLowerCase();
    // aggregate name+email + freq across all messages in the active account
    const idx = new Map<string, { name: string; email: string; freq: number }>();
    const add = (name: string, rawEmail: string) => {
      const email = rawEmail.trim().toLowerCase();
      if (!email.includes("@") || email === me) return;
      const cur = idx.get(email);
      if (cur) {
        cur.freq++;
        if (!cur.name && name) cur.name = name;
      } else {
        idx.set(email, { name: name.trim(), email, freq: 1 });
      }
    };
    const parseAddr = (raw: string): [string, string] => {
      const m = raw.match(/^\s*"?([^"<]*)"?\s*<([^>]+)>/);
      if (m) return [m[1].trim(), m[2].trim()];
      return ["", raw.trim()];
    };
    for (const t of this.threads) {
      if (!this.inActiveAccount(t)) continue;
      for (const msg of this.messages.get(t.id) ?? []) {
        add(msg.fromName, msg.from);
        for (const addr of [...msg.to, ...msg.cc]) {
          const [name, email] = parseAddr(addr);
          add(name, email);
        }
      }
    }
    const hits = [...idx.values()].filter(
      (c) => c.name.toLowerCase().includes(q) || c.email.includes(q)
    );
    hits.sort((a, b) => {
      const ap = a.name.toLowerCase().startsWith(q) || a.email.startsWith(q) ? 0 : 1;
      const bp = b.name.toLowerCase().startsWith(q) || b.email.startsWith(q) ? 0 : 1;
      return ap - bp || b.freq - a.freq;
    });
    return hits.slice(0, 8).map(({ name, email }) => ({ name, email }));
  }

  /** Tiny stand-in for Harper: a fixed misspelling list so the demo shows
   *  the underline + click-to-fix flow. The desktop app lints for real. */
  async lintText(text: string) {
    const known: Record<string, string[]> = {
      teh: ["the"],
      recieve: ["receive"],
      definately: ["definitely"],
      adress: ["address"],
      seperate: ["separate"],
      occured: ["occurred"],
      wich: ["which"],
      thier: ["their"],
    };
    const hits = [];
    const re = /[A-Za-z']+/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const fixes = known[m[0].toLowerCase()];
      if (fixes) {
        hits.push({
          span: { start: m.index, end: m.index + m[0].length },
          message: `Did you mean "${fixes[0]}"?`,
          suggestions: fixes,
        });
      }
    }
    return hits;
  }

  onMailUpdated(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
  onCalendarUpdated(cb: (error: string | null) => void): () => void {
    this.calendarListeners.add(cb);
    return () => this.calendarListeners.delete(cb);
  }
  // Demo fixtures carry real HTML + no remote images, so these never fire.
  onThreadImages(): () => void {
    return () => {};
  }
  onTriageError(): () => void {
    return () => {};
  }
  onNotice(): () => void {
    return () => {};
  }
}

/** First split (in settings order) whose rules match; empty-rule splits are
 *  the catch-all and only claim threads nothing else matched. */
export function assignSplit(t: Thread, splits: Settings["splits"]): string {
  let catchAll: string | null = null;
  for (const s of splits) {
    if (s.rules.length === 0) {
      catchAll = catchAll ?? s.id;
      continue;
    }
    const results = s.rules.map((r) => {
      const needle = r.contains.toLowerCase();
      if (!needle) return false;
      switch (r.field) {
        case "label":
          return t.labels.some((l) => l.toLowerCase().includes(needle));
        case "subject":
          return t.subject.toLowerCase().includes(needle);
        case "from":
        case "to":
          return t.participants.some((p) => p.toLowerCase().includes(needle));
      }
    });
    const matched = s.op === "and" ? results.every(Boolean) : results.some(Boolean);
    if (matched) return s.id;
  }
  return catchAll ?? "other";
}
