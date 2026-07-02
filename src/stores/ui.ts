import { create } from "zustand";
import { backend } from "@/lib/ipc";
import { splitThreads, useMail, visibleThreads } from "./mail";
import { useSettings } from "./settings";
import type { MailAttachment, OutgoingMail, ThreadId, ZeroEvent } from "@/lib/types";

export type Screen = "mail" | "settings" | "search";

export type ComposeMode = "new" | "reply" | "replyAll" | "forward";

export interface ComposeState {
  mode: ComposeMode;
  threadId: ThreadId | null;
  to: string;
  cc: string;
  subject: string;
  body: string;
  signature: string; // active account's signature, appended on send
  quote: string; // read-only quoted context shown under the editor
  attachments: MailAttachment[];
  /** Persisted-draft row backing this compose; null until first autosave. */
  draftId: number | null;
}

export function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (ch) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!
  );
}

/** True when a signature is rich HTML (images, formatting) vs plain text. */
export function isHtmlSignature(sig: string): boolean {
  return /<\w+[^>]*>/.test(sig);
}

function htmlToText(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  return (doc.body.textContent ?? "").trim();
}

/** The one place a compose window turns into an outgoing message. */
export function outgoingFromCompose(c: ComposeState): OutgoingMail {
  const split = (raw: string) =>
    raw
      .split(/[,;]/)
      .map((s) => s.trim())
      .filter(Boolean);
  const sigHtml = isHtmlSignature(c.signature);
  const sigText = sigHtml ? htmlToText(c.signature) : c.signature.trim();
  const bodyText = [c.body.trim(), sigText, c.quote.trim()]
    .filter(Boolean)
    .join("\n\n");

  // Rich signatures ride an HTML alternative; plain-text-only mail stays
  // plain so nothing changes for people without a fancy signature.
  let bodyHtml: string | null = null;
  if (sigHtml) {
    const esc = (t: string) => escapeHtml(t).replace(/\n/g, "<br>");
    const parts = [`<div>${esc(c.body.trim())}</div>`];
    parts.push(`<div>-- <br>${c.signature}</div>`);
    if (c.quote.trim()) {
      parts.push(
        `<blockquote style="margin:8px 0 0 8px;padding-left:12px;border-left:2px solid #ccc;color:#666">${esc(c.quote.trim())}</blockquote>`
      );
    }
    bodyHtml = parts.join("<br>");
  }

  return {
    threadId: c.threadId,
    to: split(c.to),
    cc: split(c.cc),
    subject: c.subject || "(no subject)",
    bodyText,
    bodyHtml,
    replyAll: c.mode === "replyAll",
    attachments: c.attachments,
  };
}

export type Picker =
  | "none"
  | "snooze"
  | "move"
  | "zeroSweep"
  | "sendLater"
  | "snippet"
  | "drafts";

interface UiState {
  screen: Screen;
  paletteOpen: boolean;
  picker: Picker;
  compose: ComposeState | null;
  celebration: ZeroEvent | null;
  toast: string | null;
  settingsTab: string;
  /** Instant Reply suggestions for the open thread. */
  suggestions: string[];
  suggestionIndex: number | null;
  /** Write-with-AI instruction bar inside compose (Ctrl+J). */
  aiBarOpen: boolean;
  /** Ask-AI overlay over the current thread (?). */
  askAiOpen: boolean;

  setScreen: (s: Screen) => void;
  openPalette: () => void;
  closePalette: () => void;
  openPicker: (p: Picker) => void;
  closePicker: () => void;
  startCompose: (c: ComposeState) => void;
  closeCompose: () => void;
  setSettingsTab: (t: string) => void;
  showToast: (msg: string) => void;
  dismissCelebration: () => void;
  setSuggestions: (s: string[]) => void;
  cycleSuggestion: () => void;
  setAiBarOpen: (open: boolean) => void;
  setAskAiOpen: (open: boolean) => void;
  /** Called after any archive-ish action: fires the celebration if the
   *  active split just hit zero. */
  checkInboxZero: () => Promise<void>;
}

let toastTimer: ReturnType<typeof setTimeout> | undefined;

export const useUi = create<UiState>((set, get) => ({
  screen: "mail",
  paletteOpen: false,
  picker: "none",
  compose: null,
  celebration: null,
  toast: null,
  settingsTab: "account",
  suggestions: [],
  suggestionIndex: null,
  aiBarOpen: false,
  askAiOpen: false,

  setScreen: (s) => set({ screen: s, paletteOpen: false, picker: "none" }),
  openPalette: () => set({ paletteOpen: true }),
  closePalette: () => set({ paletteOpen: false }),
  openPicker: (p) => set({ picker: p }),
  closePicker: () => set({ picker: "none" }),
  startCompose: (c) =>
    set({ compose: c, screen: "mail", aiBarOpen: false, askAiOpen: false }),
  closeCompose: () => set({ compose: null, aiBarOpen: false }),
  setSettingsTab: (t) => set({ settingsTab: t }),
  setSuggestions: (s) => set({ suggestions: s, suggestionIndex: null }),
  cycleSuggestion: () =>
    set((st) => {
      if (st.suggestions.length === 0) return {};
      const next =
        st.suggestionIndex === null
          ? 0
          : (st.suggestionIndex + 1) % st.suggestions.length;
      return { suggestionIndex: next };
    }),
  setAiBarOpen: (open) => set({ aiBarOpen: open }),
  setAskAiOpen: (open) => set({ askAiOpen: open }),

  showToast: (msg) => {
    set({ toast: msg });
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => set({ toast: null }), 2600);
  },

  dismissCelebration: () => set({ celebration: null }),

  checkInboxZero: async () => {
    const mail = useMail.getState();
    if (mail.listView !== "inbox" || !mail.loaded) return;
    if (get().celebration) return;
    const remaining = splitThreads(mail.inbox, mail.activeSplitId).length;
    if (remaining > 0) return;
    const event = await backend.recordZero(mail.activeSplitId);
    if (event) {
      // refresh streaks shown in settings
      void useSettings.getState().load();
      set({ celebration: event });
    }
  },
}));

/** The thread the user is acting on: the open one, else the list selection. */
export function actionTargetThreadId(): ThreadId | null {
  const mail = useMail.getState();
  if (mail.openThreadId) return mail.openThreadId;
  const list = visibleThreads(mail);
  return list[mail.selectedIndex]?.id ?? null;
}
