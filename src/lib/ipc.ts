// The single seam between UI and backend. In the Tauri app every call goes
// to the Rust core; in a plain browser (vite dev without Tauri) the mock
// backend serves the same surface so the whole UX runs against fixtures.
import { invoke, Channel } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  AccountsState,
  AiProviderId,
  DraftRequest,
  KnowledgeBase,
  Message,
  OutgoingMail,
  SearchResult,
  Settings,
  Streaks,
  Thread,
  ThreadId,
  ZeroEvent,
} from "./types";
import { MockBackend } from "./mock";

export type MailView = "inbox" | "done" | "reminders";

export interface BulkArchiveOpts {
  splitId: string | null; // null = whole inbox
  olderThanDays: number; // 0 = everything
  preserveUnread: boolean;
  preserveStarred: boolean;
}

export interface DraftStreamHandlers {
  onChunk: (text: string) => void;
  onDone: () => void;
  onError: (message: string) => void;
}

export interface Backend {
  getAccounts(): Promise<AccountsState>;
  switchAccount(email: string): Promise<AccountsState>;
  reorderAccounts(emails: string[]): Promise<AccountsState>;
  hasGmailClient(): Promise<boolean>;
  /** Blank strings reuse the OAuth client already in the keychain. */
  startOauth(clientId: string, clientSecret: string): Promise<AccountsState>;
  disconnect(email: string): Promise<AccountsState>;
  syncNow(): Promise<void>;

  listThreads(view: MailView): Promise<Thread[]>;
  getThread(id: ThreadId): Promise<Message[]>;
  archiveThread(id: ThreadId): Promise<void>;
  moveToInbox(id: ThreadId): Promise<void>;
  trashThread(id: ThreadId): Promise<void>;
  toggleStar(id: ThreadId): Promise<boolean>;
  snoozeThread(id: ThreadId, untilMs: number): Promise<void>;
  markUnread(id: ThreadId): Promise<void>;
  markRead(id: ThreadId): Promise<void>;
  moveLabel(id: ThreadId, label: string): Promise<void>;
  listLabels(): Promise<string[]>;
  sendMail(mail: OutgoingMail): Promise<void>;
  search(query: string): Promise<SearchResult[]>;
  bulkArchive(opts: BulkArchiveOpts): Promise<number>;

  getSettings(): Promise<Settings>;
  saveSettings(settings: Settings): Promise<void>;
  getKnowledgeBase(): Promise<KnowledgeBase>;
  saveKnowledgeBase(kb: KnowledgeBase): Promise<void>;

  setAiKey(provider: AiProviderId, key: string): Promise<void>;
  testAiProvider(provider: AiProviderId): Promise<{ ok: boolean; message: string }>;
  /** Returns a cancel function. Handlers fire as the draft streams in. */
  aiDraft(req: DraftRequest, handlers: DraftStreamHandlers): () => void;
  aiSuggestReplies(threadId: ThreadId): Promise<string[]>;

  getStreaks(): Promise<Streaks>;
  recordZero(splitId: string): Promise<ZeroEvent | null>;
  listCelebrationImages(): Promise<string[]>;

  /** Backend pushes when sync/reminders change mail state. Returns unsubscribe. */
  onMailUpdated(cb: () => void): () => void;
}

export const isTauri =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

let aiRequestSeq = 1;

class TauriBackend implements Backend {
  getAccounts() {
    return invoke<AccountsState>("get_accounts");
  }
  switchAccount(email: string) {
    return invoke<AccountsState>("switch_account", { email });
  }
  reorderAccounts(emails: string[]) {
    return invoke<AccountsState>("reorder_accounts", { emails });
  }
  hasGmailClient() {
    return invoke<boolean>("has_gmail_client");
  }
  startOauth(clientId: string, clientSecret: string) {
    return invoke<AccountsState>("start_oauth", { clientId, clientSecret });
  }
  disconnect(email: string) {
    return invoke<AccountsState>("disconnect_account", { email });
  }
  syncNow() {
    return invoke<void>("sync_now");
  }
  listThreads(view: MailView) {
    return invoke<Thread[]>("list_threads", { view });
  }
  getThread(id: ThreadId) {
    return invoke<Message[]>("get_thread", { threadId: id });
  }
  archiveThread(id: ThreadId) {
    return invoke<void>("archive_thread", { threadId: id });
  }
  moveToInbox(id: ThreadId) {
    return invoke<void>("move_to_inbox", { threadId: id });
  }
  trashThread(id: ThreadId) {
    return invoke<void>("trash_thread", { threadId: id });
  }
  toggleStar(id: ThreadId) {
    return invoke<boolean>("toggle_star", { threadId: id });
  }
  snoozeThread(id: ThreadId, untilMs: number) {
    return invoke<void>("snooze_thread", { threadId: id, untilMs });
  }
  markUnread(id: ThreadId) {
    return invoke<void>("mark_unread", { threadId: id });
  }
  markRead(id: ThreadId) {
    return invoke<void>("mark_read", { threadId: id });
  }
  moveLabel(id: ThreadId, label: string) {
    return invoke<void>("move_label", { threadId: id, label });
  }
  listLabels() {
    return invoke<string[]>("list_labels");
  }
  sendMail(mail: OutgoingMail) {
    return invoke<void>("send_mail", { mail });
  }
  search(query: string) {
    return invoke<SearchResult[]>("search_threads", { query });
  }
  bulkArchive(opts: BulkArchiveOpts) {
    return invoke<number>("bulk_archive", { opts });
  }
  getSettings() {
    return invoke<Settings>("get_settings");
  }
  saveSettings(settings: Settings) {
    return invoke<void>("save_settings", { settings });
  }
  getKnowledgeBase() {
    return invoke<KnowledgeBase>("get_knowledge_base");
  }
  saveKnowledgeBase(kb: KnowledgeBase) {
    return invoke<void>("save_knowledge_base", { kb });
  }
  setAiKey(provider: AiProviderId, key: string) {
    return invoke<void>("set_ai_key", { provider, key });
  }
  testAiProvider(provider: AiProviderId) {
    return invoke<{ ok: boolean; message: string }>("test_ai_provider", {
      provider,
    });
  }
  aiDraft(req: DraftRequest, handlers: DraftStreamHandlers): () => void {
    const requestId = aiRequestSeq++;
    let cancelled = false;
    const channel = new Channel<string>();
    channel.onmessage = (chunk) => {
      if (!cancelled) handlers.onChunk(chunk);
    };
    invoke<void>("ai_draft", { req, requestId, onChunk: channel })
      .then(() => {
        if (!cancelled) handlers.onDone();
      })
      .catch((err) => {
        if (!cancelled) handlers.onError(String(err));
      });
    return () => {
      cancelled = true;
      void invoke("cancel_ai", { requestId }).catch(() => {});
    };
  }
  aiSuggestReplies(threadId: ThreadId) {
    return invoke<string[]>("ai_suggest_replies", { threadId });
  }
  getStreaks() {
    return invoke<Streaks>("get_streaks");
  }
  recordZero(splitId: string) {
    return invoke<ZeroEvent | null>("record_zero", { splitId });
  }
  listCelebrationImages() {
    return invoke<string[]>("list_celebration_images");
  }
  onMailUpdated(cb: () => void): () => void {
    const un = listen("mail:updated", cb);
    return () => {
      void un.then((f) => f());
    };
  }
}

export const backend: Backend = isTauri ? new TauriBackend() : new MockBackend();
