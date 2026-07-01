import { create } from "zustand";
import { backend } from "@/lib/ipc";
import { splitThreads, useMail, visibleThreads } from "./mail";
import { useSettings } from "./settings";
import type { ThreadId, ZeroEvent } from "@/lib/types";

export type Screen = "mail" | "settings" | "search";

export type ComposeMode = "new" | "reply" | "replyAll" | "forward";

export interface ComposeState {
  mode: ComposeMode;
  threadId: ThreadId | null;
  to: string;
  cc: string;
  subject: string;
  body: string;
  quote: string; // read-only quoted context shown under the editor
}

export type Picker = "none" | "snooze" | "move" | "zeroSweep";

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
