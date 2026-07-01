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
  {
    id: "calendar",
    name: "Calendar",
    builtin: true,
    rules: [
      { field: "label", contains: "CALENDAR" },
      { field: "subject", contains: "Invitation:" },
      { field: "from", contains: "calendar-invite" },
    ],
    op: "or",
    hideWhenEmpty: false,
  },
];

export const DEFAULT_SHORTCUTS: Record<string, string> = {
  "palette.open": "mod+k",
  compose: "c",
  "thread.done": "e",
  "thread.snooze": "h",
  "thread.reply": "r",
  "thread.forward": "f",
  "thread.replyAllOrOpen": "enter",
  "list.next": "j|down",
  "list.prev": "k|up",
  "thread.unread": "u",
  "thread.move": "v",
  search: "/",
  "ai.ask": "?",
  "split.next": "tab",
  "split.prev": "shift+tab",
  "goto.inbox": "g i",
  "goto.done": "g e",
  "goto.reminders": "g h",
  "compose.ai": "mod+j",
  "compose.send": "mod+enter",
  "thread.cycleSuggestion": "tab",
  back: "escape",
  "inbox.zeroSweep": "",
  "sync.now": "",
  "settings.open": "mod+,",
};

export function defaultSettings(): Settings {
  return {
    splits: DEFAULT_SPLITS.map((s) => ({ ...s, rules: [...s.rules] })),
    defaultAiProvider: "claude",
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
        model: "meta/llama-3.3-70b-instruct",
        baseUrl: "https://integrate.api.nvidia.com/v1",
        hasKey: false,
      },
    ],
    celebrationDir: null,
    shortcuts: { ...DEFAULT_SHORTCUTS },
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
