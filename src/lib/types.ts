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
  signatures: Record<string, string>; // account email -> signature text or HTML
  theme: "dark" | "light";
  /** Desktop notifications for new mail (while the window is unfocused). */
  notifications: boolean;
  /** Welcome flow completed. */
  onboarded: boolean;
  /** Calendar side panel visible. */
  calendarOpen: boolean;
  /** Folder/label sidebar visible. */
  sidebarOpen: boolean;
  /** Bottom shortcut-hint footer visible (default true). */
  showShortcutBar: boolean;
  /** Undo Send window in seconds: 0 = off (send immediately), else the delay
   *  before the message actually leaves. Default 10. */
  undoSendSeconds: number;
  /** Oversized attachments → Drive links: confirm per drop, or just do it. */
  driveAutoUpload: "ask" | "always";
  /** Remembered share-on-send choice for linked Drive files. */
  driveShareMode: DriveShareMode;
}

/** Which Google features this account's OAuth grant actually covers. Users
 *  can uncheck scopes on the consent screen; accounts connected before v0.15
 *  predate the new scopes entirely (legacyGrant) — every Google feature gates
 *  on this instead of assuming the full block was granted. */
export interface Capabilities {
  drive: boolean;
  contacts: boolean;
  calendarWrite: boolean;
  settingsRead: boolean;
  legacyGrant: boolean;
}

/** One Gmail send-as alias (users.settings.sendAs, read-only surface). */
export interface SendAsAlias {
  email: string;
  displayName: string;
  isDefault: boolean;
  verified: boolean;
  hasSignature: boolean;
}

/** Connected-account profile shown in the header (picture is a data: URI). */
export interface ProfileInfo {
  name: string;
  picture: string | null;
}

/** One spell/grammar finding from the local Harper linter. Offsets are
 *  UTF-16 code units into the linted string; "" in suggestions = delete. */
export interface LintHit {
  span: { start: number; end: number };
  message: string;
  suggestions: string[];
}

/** A person the account has corresponded with — recipient autocomplete. */
export interface Contact {
  name: string;
  email: string;
}

/** Daily Unsplash photo for empty rest states. Links come utm-tagged. */
export interface DailyPhoto {
  url: string;
  blurHash: string | null;
  authorName: string;
  authorLink: string | null;
  photoLink: string | null;
  downloadLocation: string | null;
  cachedDataUri: string | null;
  fetchedAt: number;
}

/** One event in the calendar side panel. */
export interface CalendarEvent {
  id: string;
  calendar: string;
  color: string | null;
  title: string;
  startMs: number;
  endMs: number;
  allDay: boolean;
  location: string | null;
}

export interface UnsubResult {
  kind: "opened" | "mailto" | "none";
  target: string | null;
}

export interface DraftRequest {
  threadId: ThreadId | null; // null = fresh compose
  instruction: string;
  existingText: string | null; // when editing an existing draft body
  providerId: AiProviderId | null; // null = default
}

/** One Google Drive file (picker rows, link chips, upload results). */
export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  size: number | null;
  webViewLink: string;
  iconLink: string | null;
  modifiedTime: string | null;
  owner: string | null;
}

/** Outcome of one uploaded chunk: not done yet, or the finished file.
 *  nextOffset is the server-acknowledged high-water mark — slice the next
 *  chunk from here (Drive may persist less than was sent). */
export interface DriveChunkResult {
  done: boolean;
  file: DriveFile | null;
  nextOffset: number;
}

/** How linked Drive files get shared when a message sends. */
export type DriveShareMode = "recipients" | "anyone" | "none";

/** A file attached to an outgoing message (base64 so the outbox survives restarts). */
export interface MailAttachment {
  filename: string;
  mimeType: string;
  dataBase64: string;
}

export interface OutgoingMail {
  threadId: ThreadId | null; // reply target, null = new thread
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  bodyText: string;
  /** HTML alternative (signatures with images); null = plain text only. */
  bodyHtml: string | null;
  replyAll: boolean;
  attachments: MailAttachment[];
}

/** A locally persisted, unsent compose draft (payload = ComposeState JSON). */
export interface DraftEntry {
  id: number;
  payload: string;
  updatedAt: number;
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
