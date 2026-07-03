// Defaults shared by the mock backend and the settings UI.
// The Rust core keeps an identical set in src-tauri/src/store/mod.rs.
import type { KnowledgeBase, Settings, Split } from "./types";

export const DEFAULT_SPLITS: Split[] = [
  {
    id: "important",
    name: "Important",
    builtin: true,
    rules: [{ field: "label", contains: "IMPORTANT" }],
    op: "or",
    hideWhenEmpty: false,
  },
  {
    id: "other",
    name: "Other",
    builtin: true,
    rules: [], // empty rules = catch-all for threads no other split claims
    op: "or",
    hideWhenEmpty: false,
  },
  // The old builtin "Calendar" split is gone as of v0.7 — the calendar lives
  // in a toggleable side panel now; saved copies are dropped on load.
];

// Aligned with Superhuman v7 (Windows & Linux edition): A reply-all, S star,
// # trash, Shift+E mark not done, U toggles read/unread, G-then-O Other,
// Ctrl+Shift+Enter send & mark done, Ctrl+1-9 switch accounts.
export const DEFAULT_SHORTCUTS: Record<string, string> = {
  "palette.open": "mod+k",
  compose: "c",
  "thread.done": "e",
  "thread.notDone": "shift+e",
  "thread.snooze": "h",
  "thread.reply": "r",
  "thread.replyAll": "a",
  "thread.forward": "f",
  "thread.replyAllOrOpen": "enter",
  "thread.star": "s",
  "thread.trash": "#|delete|backspace",
  "thread.spam": "!",
  "thread.mute": "m",
  "thread.unsubscribe": "mod+u",
  undo: "z|mod+z",
  "list.next": "j|down",
  "list.prev": "k|up",
  "thread.unread": "u",
  "thread.move": "v",
  search: "/",
  "ai.ask": "?",
  "split.next": "tab",
  "split.prev": "shift+tab",
  "goto.inbox": "g i",
  "goto.other": "g o",
  "goto.done": "g e",
  "goto.reminders": "g h",
  "goto.starred": "g s",
  "goto.trash": "g t",
  "goto.drafts": "g d",
  "compose.ai": "mod+j",
  "compose.send": "mod+enter",
  "compose.sendDone": "mod+shift+enter",
  "compose.sendLater": "mod+shift+l",
  "compose.snippet": "mod+;",
  "theme.toggle": "",
  "calendar.toggle": "",
  "calendar.open": "g c",
  "calendar.prevDay": "left",
  "calendar.nextDay": "right",
  "calendar.today": "",
  "sidebar.toggle": "",
  "shortcutBar.toggle": "",
  "list.selectAll": "mod+a",
  "list.toggleSelect": "x",
  "thread.cycleSuggestion": "tab",
  "thread.scrollDown": "space",
  back: "escape",
  "inbox.zeroSweep": "",
  "sync.now": "",
  "sync.resync": "",
  "update.check": "",
  "settings.open": "mod+,",
  // Alt+N (was mod+N through v0.5) — keeps Ctrl+N for browser muscle memory
  "account.1": "alt+1",
  "account.2": "alt+2",
  "account.3": "alt+3",
  "account.4": "alt+4",
  "account.5": "alt+5",
  "account.6": "alt+6",
  "account.7": "alt+7",
  "account.8": "alt+8",
  "account.9": "alt+9",
};

export function defaultSettings(): Settings {
  return {
    splits: DEFAULT_SPLITS.map((s) => ({ ...s, rules: [...s.rules] })),
    // NIM/DeepSeek is the default because it's the key the user supplied
    defaultAiProvider: "nim",
    providers: [
      {
        id: "claude",
        label: "Claude",
        model: "claude-sonnet-5",
        baseUrl: null,
        hasKey: false,
      },
      {
        id: "openai",
        label: "OpenAI",
        model: "gpt-5.2",
        baseUrl: null,
        hasKey: false,
      },
      {
        id: "nim",
        label: "NVIDIA NIM",
        model: "deepseek-ai/deepseek-v4-pro",
        baseUrl: "https://integrate.api.nvidia.com/v1",
        hasKey: false,
      },
    ],
    celebrationDir: null,
    shortcuts: { ...DEFAULT_SHORTCUTS },
    signatures: {},
    theme: "dark",
    notifications: true,
    onboarded: false,
    calendarOpen: false,
    sidebarOpen: false,
    showShortcutBar: true,
  };
}

export function defaultKnowledgeBase(): KnowledgeBase {
  return { instructions: "", snippets: [], voiceExamples: [] };
}

export const BUNDLED_CELEBRATIONS = [
  "/inbox-zero/dawn-ridge.svg",
  "/inbox-zero/quiet-lake.svg",
  "/inbox-zero/night-dunes.svg",
  "/inbox-zero/aurora-field.svg",
];
