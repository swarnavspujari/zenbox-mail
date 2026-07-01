// Shared domain types. These mirror the Rust structs in src-tauri/src/
// (serde uses camelCase rename on every IPC-crossing struct).

export type ThreadId = string;
export type MessageId = string;

export interface Attachment {
  id: string;
  messageId: MessageId;
  filename: string;
  mimeType: string;
  sizeBytes: number;
}

export interface Message {
  id: MessageId;
  threadId: ThreadId;
  from: string;
  fromName: string;
  to: string[];
  cc: string[];
  subject: string;
  snippet: string;
  bodyText: string;
  bodyHtml: string | null;
  date: number; // unix ms
  unread: boolean;
  attachments: Attachment[];
}

export interface Thread {
  id: ThreadId;
  subject: string;
  snippet: string;
  participants: string[];
  messageCount: number;
  lastDate: number; // unix ms
  unread: boolean;
  starred: boolean;
  labels: string[];
  inInbox: boolean;
  snoozedUntil: number | null; // unix ms
}

export type SplitField = "from" | "to" | "subject" | "label";
export type SplitOp = "and" | "or";

export interface SplitRule {
  field: SplitField;
  contains: string;
}

export interface Split {
  id: string;
  name: string;
  builtin: boolean;
  rules: SplitRule[];
  op: SplitOp;
  hideWhenEmpty: boolean;
}

export type AiProviderId = "claude" | "openai" | "nim";

export interface AiProviderConfig {
  id: AiProviderId;
  label: string;
  model: string;
  baseUrl: string | null; // used by NIM / self-hosted OpenAI-compatible
  hasKey: boolean; // key itself never crosses IPC back to the UI
}

export interface KnowledgeBase {
  instructions: string;
  snippets: { id: string; title: string; body: string }[];
  voiceExamples: { id: string; title: string; body: string }[];
}

export interface Streaks {
  daily: number;
  weekly: number;
  lastZeroDay: string | null; // YYYY-MM-DD
}

export interface AccountInfo {
  email: string;
  provider: "gmail" | "outlook" | "mock";
  connected: boolean;
}

/** All connected accounts in slot order (index 0 = Ctrl+1) + the active one. */
export interface AccountsState {
  accounts: AccountInfo[];
  active: string;
}

export interface Settings {
  splits: Split[];
  defaultAiProvider: AiProviderId;
  providers: AiProviderConfig[];
  celebrationDir: string | null; // user-supplied folder of images; null = bundled
  shortcuts: Record<string, string>; // commandId -> key expression
  signatures: Record<string, string>; // account email -> signature text
}

export interface DraftRequest {
  threadId: ThreadId | null; // null = fresh compose
  instruction: string;
  existingText: string | null; // when editing an existing draft body
  providerId: AiProviderId | null; // null = default
}

export interface OutgoingMail {
  threadId: ThreadId | null; // reply target, null = new thread
  to: string[];
  cc: string[];
  subject: string;
  bodyText: string;
  replyAll: boolean;
}

export interface SearchResult {
  threadId: ThreadId;
  subject: string;
  snippet: string;
  lastDate: number;
}

export interface ZeroEvent {
  splitId: string;
  daily: number;
  weekly: number;
  imagePath: string; // asset path or file path to show
}
