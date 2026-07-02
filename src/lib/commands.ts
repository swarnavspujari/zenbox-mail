// Every user action, defined once. The command palette lists these; the
// keyboard engine binds them via the (remappable) shortcut map in settings.
import { backend } from "./ipc";
import type { Binding } from "./keyboard";
import { popUndo, pushUndo } from "./undo";
import { useMail, visibleThreads } from "@/stores/mail";
import { activeSignature, useSettings } from "@/stores/settings";
import {
  actionTargetThreadId,
  useUi,
  type ComposeState,
} from "@/stores/ui";
import type { Message, ThreadId } from "./types";

export interface Command {
  id: string;
  title: string;
  /** Section header in the palette. */
  group: string;
  hidden?: boolean;
  when?: () => boolean;
  run: () => void | Promise<void>;
}

// ---- context predicates ----------------------------------------------------

const ui = () => useUi.getState();
const mail = () => useMail.getState();

const inCompose = () => ui().compose !== null;
const onMailScreen = () => ui().screen === "mail" && !inCompose();
const inThread = () => onMailScreen() && mail().openThreadId !== null;
const inList = () => onMailScreen() && mail().openThreadId === null;
const hasTarget = () => actionTargetThreadId() !== null;

// ---- compose helpers --------------------------------------------------------

function quoteOf(m: Message): string {
  const when = new Date(m.date).toLocaleString();
  return `On ${when}, ${m.fromName} <${m.from}> wrote:\n> ${m.bodyText.split("\n").join("\n> ")}`;
}

async function messagesFor(id: ThreadId): Promise<Message[]> {
  const m = mail();
  if (m.openThreadId === id && m.openMessages.length) return m.openMessages;
  return backend.getThread(id);
}

function myAddress(): string {
  return useSettings.getState().accounts.active ?? "";
}

export async function startReply(
  mode: "reply" | "replyAll" | "forward",
  presetBody?: string
) {
  const id = actionTargetThreadId();
  if (!id) return;
  const msgs = await messagesFor(id);
  if (msgs.length === 0) return;
  const me = myAddress().toLowerCase();
  // reply to the most recent message that isn't ours
  const last =
    [...msgs].reverse().find((m) => m.from.toLowerCase() !== me) ??
    msgs[msgs.length - 1];

  const subject = msgs[0].subject;
  const base: ComposeState = {
    mode,
    threadId: id,
    to: "",
    cc: "",
    signature: activeSignature(),
    subject:
      mode === "forward"
        ? subject.startsWith("Fwd:")
          ? subject
          : `Fwd: ${subject}`
        : subject.startsWith("Re:")
          ? subject
          : `Re: ${subject}`,
    body: presetBody ?? "",
    quote: quoteOf(last),
  };
  if (mode === "reply") {
    base.to = last.from;
  } else if (mode === "replyAll") {
    const others = new Set<string>();
    others.add(last.from);
    for (const a of [...last.to, ...last.cc]) {
      if (a.toLowerCase() !== me) others.add(a);
    }
    const [first, ...rest] = [...others];
    base.to = first ?? "";
    base.cc = rest.join(", ");
  }
  ui().startCompose(base);
}

function pickedSuggestion(): string | undefined {
  const u = ui();
  return u.suggestionIndex === null
    ? undefined
    : u.suggestions[u.suggestionIndex];
}

/** Standard undo entry for a triage action: run the inverse, refresh, toast. */
export function pushTriageUndo(label: string, inverse: () => Promise<void>) {
  pushUndo({
    label,
    run: async () => {
      await inverse();
      await mail().refresh();
      ui().showToast(`Undone — ${label}`);
    },
  });
}

// ---- the registry -----------------------------------------------------------

export function allCommands(): Command[] {
  return [
    {
      id: "palette.open",
      title: "Command Palette",
      group: "General",
      run: () => (ui().paletteOpen ? ui().closePalette() : ui().openPalette()),
    },
    {
      id: "compose",
      title: "Compose New Email",
      group: "Compose",
      when: () => !inCompose(),
      run: () =>
        ui().startCompose({
          mode: "new",
          threadId: null,
          to: "",
          cc: "",
          subject: "",
          body: "",
          signature: activeSignature(),
          quote: "",
        }),
    },
    {
      id: "thread.done",
      title: "Mark Done (archive)",
      group: "Triage",
      when: () => hasTarget() && !inCompose(),
      run: async () => {
        const id = actionTargetThreadId();
        if (!id) return;
        if (mail().openThreadId === id) mail().closeThread();
        await mail().archive(id);
        pushTriageUndo("Mark Done", () => mail().moveToInbox(id));
        ui().showToast("Done");
        await ui().checkInboxZero();
      },
    },
    {
      id: "thread.notDone",
      title: "Mark Not Done (back to inbox)",
      group: "Triage",
      when: () => hasTarget() && !inCompose() && mail().listView !== "inbox",
      run: async () => {
        const id = actionTargetThreadId();
        if (!id) return;
        if (mail().openThreadId === id) mail().closeThread();
        await mail().moveToInbox(id);
        pushTriageUndo("Mark Not Done", () => mail().archive(id));
        ui().showToast("Moved to inbox");
      },
    },
    {
      id: "thread.trash",
      title: "Trash",
      group: "Triage",
      when: () => hasTarget() && !inCompose(),
      run: async () => {
        const id = actionTargetThreadId();
        if (!id) return;
        if (mail().openThreadId === id) mail().closeThread();
        await mail().hide(id, "trash");
        pushTriageUndo("Trash", () => mail().restore(id));
        ui().showToast("Moved to trash — Z to undo");
        await ui().checkInboxZero();
      },
    },
    {
      id: "thread.spam",
      title: "Mark Spam",
      group: "Triage",
      when: () => hasTarget() && !inCompose(),
      run: async () => {
        const id = actionTargetThreadId();
        if (!id) return;
        if (mail().openThreadId === id) mail().closeThread();
        await mail().hide(id, "spam");
        pushTriageUndo("Mark Spam", () => mail().restore(id));
        ui().showToast("Marked spam — Z to undo");
        await ui().checkInboxZero();
      },
    },
    {
      id: "thread.mute",
      title: "Mute (archive + auto-archive replies)",
      group: "Triage",
      when: () => hasTarget() && !inCompose(),
      run: async () => {
        const id = actionTargetThreadId();
        if (!id) return;
        if (mail().openThreadId === id) mail().closeThread();
        await mail().mute(id);
        pushTriageUndo("Mute", () => mail().unmute(id));
        ui().showToast("Muted — Z to undo");
        await ui().checkInboxZero();
      },
    },
    {
      id: "thread.unsubscribe",
      title: "Unsubscribe",
      group: "Triage",
      when: () => hasTarget() && !inCompose(),
      run: async () => {
        const id = actionTargetThreadId();
        if (!id) return;
        const r = await backend.unsubscribeThread(id);
        if (r.kind === "opened") {
          ui().showToast("Unsubscribe page opened in your browser");
        } else if (r.kind === "mailto" && r.target) {
          ui().startCompose({
            mode: "new",
            threadId: null,
            to: r.target,
            cc: "",
            subject: "Unsubscribe",
            body: "Please unsubscribe me from this list.",
            signature: "",
            quote: "",
          });
        } else {
          ui().showToast("No unsubscribe link in this thread");
        }
      },
    },
    {
      id: "undo",
      title: "Undo",
      group: "General",
      when: () => !inCompose(),
      run: async () => {
        const handled = await popUndo();
        if (!handled) ui().showToast("Nothing to undo");
      },
    },
    {
      id: "thread.star",
      title: "Star / Unstar",
      group: "Triage",
      when: () => hasTarget() && !inCompose(),
      run: async () => {
        const id = actionTargetThreadId();
        if (!id) return;
        await mail().toggleStar(id);
        pushTriageUndo("Star", () => mail().toggleStar(id));
      },
    },
    {
      id: "thread.snooze",
      title: "Remind Me / Snooze…",
      group: "Triage",
      when: () => hasTarget() && !inCompose(),
      run: () => ui().openPicker("snooze"),
    },
    {
      id: "thread.reply",
      title: "Reply",
      group: "Compose",
      when: () => hasTarget() && !inCompose(),
      run: () => startReply("reply", pickedSuggestion()),
    },
    {
      id: "thread.forward",
      title: "Forward",
      group: "Compose",
      when: () => hasTarget() && !inCompose(),
      run: () => startReply("forward"),
    },
    {
      id: "thread.replyAllOrOpen",
      title: "Open / Reply All",
      group: "Compose",
      hidden: true,
      when: () => (inList() && hasTarget()) || inThread(),
      run: async () => {
        if (inList()) {
          const id = actionTargetThreadId();
          if (id) await mail().openThread(id);
        } else {
          await startReply("replyAll", pickedSuggestion());
        }
      },
    },
    {
      id: "thread.replyAll",
      title: "Reply All",
      group: "Compose",
      when: () => hasTarget() && !inCompose(),
      run: () => startReply("replyAll", pickedSuggestion()),
    },
    {
      id: "list.next",
      title: "Next Conversation",
      group: "Navigate",
      when: () => onMailScreen(),
      run: async () => {
        const m = mail();
        m.moveSelection(1);
        if (m.openThreadId) {
          const t = visibleThreads(useMail.getState())[
            useMail.getState().selectedIndex
          ];
          if (t) await m.openThread(t.id);
        }
      },
    },
    {
      id: "list.prev",
      title: "Previous Conversation",
      group: "Navigate",
      when: () => onMailScreen(),
      run: async () => {
        const m = mail();
        m.moveSelection(-1);
        if (m.openThreadId) {
          const t = visibleThreads(useMail.getState())[
            useMail.getState().selectedIndex
          ];
          if (t) await m.openThread(t.id);
        }
      },
    },
    {
      id: "thread.unread",
      title: "Mark Read / Unread",
      group: "Triage",
      when: () => hasTarget() && !inCompose(),
      run: async () => {
        const id = actionTargetThreadId();
        if (!id) return;
        const m = mail();
        const t =
          m.inbox.find((t) => t.id === id) ??
          m.done.find((t) => t.id === id) ??
          m.reminders.find((t) => t.id === id);
        if (t?.unread) {
          await m.markRead(id);
          ui().showToast("Marked read");
        } else {
          await m.markUnread(id);
          if (m.openThreadId === id) m.closeThread();
          ui().showToast("Marked unread");
        }
      },
    },
    {
      id: "thread.move",
      title: "Move to Folder / Label…",
      group: "Triage",
      when: () => hasTarget() && !inCompose(),
      run: () => ui().openPicker("move"),
    },
    {
      id: "search",
      title: "Search",
      group: "Navigate",
      when: () => !inCompose(),
      run: () => ui().setScreen("search"),
    },
    {
      id: "ai.ask",
      title: "Ask AI (about this thread)",
      group: "AI",
      when: () => hasTarget() && !inCompose(),
      run: async () => {
        const id = actionTargetThreadId();
        if (!id) return;
        if (!mail().openThreadId) await mail().openThread(id);
        ui().setAskAiOpen(true);
      },
    },
    {
      id: "split.next",
      title: "Next Split Inbox",
      group: "Navigate",
      when: () => inList() && mail().listView === "inbox",
      run: () => mail().cycleSplit(1),
    },
    {
      id: "split.prev",
      title: "Previous Split Inbox",
      group: "Navigate",
      when: () => inList() && mail().listView === "inbox",
      run: () => mail().cycleSplit(-1),
    },
    {
      id: "thread.cycleSuggestion",
      title: "Preview Next Instant Reply",
      group: "AI",
      hidden: true,
      when: () => inThread() && ui().suggestions.length > 0,
      run: () => ui().cycleSuggestion(),
    },
    {
      id: "goto.inbox",
      title: "Go to Inbox",
      group: "Navigate",
      when: () => !inCompose(),
      run: () => {
        mail().closeThread();
        mail().setListView("inbox");
        mail().setActiveSplit("important");
        ui().setScreen("mail");
      },
    },
    {
      id: "goto.other",
      title: "Go to Other",
      group: "Navigate",
      when: () => !inCompose(),
      run: () => {
        mail().closeThread();
        mail().setListView("inbox");
        mail().setActiveSplit("other");
        ui().setScreen("mail");
      },
    },
    {
      id: "goto.done",
      title: "Go to Done",
      group: "Navigate",
      when: () => !inCompose(),
      run: () => {
        mail().closeThread();
        mail().setListView("done");
        ui().setScreen("mail");
      },
    },
    {
      id: "goto.reminders",
      title: "Go to Reminders",
      group: "Navigate",
      when: () => !inCompose(),
      run: () => {
        mail().closeThread();
        mail().setListView("reminders");
        ui().setScreen("mail");
      },
    },
    {
      id: "goto.starred",
      title: "Go to Starred",
      group: "Navigate",
      when: () => !inCompose(),
      run: () => {
        mail().closeThread();
        mail().setListView("starred");
        ui().setScreen("mail");
      },
    },
    {
      id: "compose.ai",
      title: "Write with AI",
      group: "AI",
      when: () => inCompose(),
      run: () => ui().setAiBarOpen(!ui().aiBarOpen),
    },
    {
      id: "compose.send",
      title: "Send",
      group: "Compose",
      hidden: true,
      when: () => inCompose(),
      run: () => {
        // Compose owns validation + the actual send; reach it via event so
        // draft state lives in exactly one place.
        window.dispatchEvent(new CustomEvent("zenbox:send"));
      },
    },
    {
      id: "compose.sendDone",
      title: "Send & Mark Done",
      group: "Compose",
      hidden: true,
      when: () => inCompose(),
      run: () => {
        window.dispatchEvent(
          new CustomEvent("zenbox:send", { detail: { markDone: true } })
        );
      },
    },
    {
      id: "compose.sendLater",
      title: "Send Later…",
      group: "Compose",
      when: () => inCompose(),
      run: () => ui().openPicker("sendLater"),
    },
    {
      id: "compose.snippet",
      title: "Insert Snippet…",
      group: "Compose",
      when: () => inCompose(),
      run: () => ui().openPicker("snippet"),
    },
    {
      id: "theme.toggle",
      title: "Toggle Light / Dark Theme",
      group: "General",
      run: () => {
        const s = useSettings.getState();
        void s.save({ theme: s.settings.theme === "dark" ? "light" : "dark" });
      },
    },
    // Ctrl+1..9 — Superhuman-style account switching (slots are the order in
    // Settings → Account; reassign by reordering there).
    ...Array.from({ length: 9 }, (_, i) => {
      const slot = i + 1;
      const email =
        useSettings.getState().accounts.accounts[slot - 1]?.email ??
        `Account ${slot}`;
      return {
        id: `account.${slot}`,
        title: `Switch to ${email}`,
        group: "Accounts",
        when: () => useSettings.getState().accounts.accounts.length >= slot,
        run: async () => {
          const s = useSettings.getState();
          const target = s.accounts.accounts[slot - 1];
          if (!target || target.email === s.accounts.active) return;
          mail().closeThread();
          await s.switchAccount(target.email);
          await mail().refresh();
          ui().setScreen("mail");
          ui().showToast(target.email);
        },
      } satisfies Command;
    }),
    {
      id: "inbox.zeroSweep",
      title: "Get Me To Zero (bulk archive)…",
      group: "Triage",
      when: () => inList() && mail().listView === "inbox",
      run: () => ui().openPicker("zeroSweep"),
    },
    {
      id: "sync.now",
      title: "Sync Now",
      group: "General",
      run: async () => {
        await backend.syncNow();
        await mail().refresh();
        ui().showToast("Synced");
      },
    },
    {
      id: "settings.open",
      title: "Settings",
      group: "General",
      run: () => ui().setScreen("settings"),
    },
    {
      id: "back",
      title: "Back / Close",
      group: "General",
      hidden: true,
      run: () => {
        const u = ui();
        if (u.askAiOpen) return u.setAskAiOpen(false);
        if (u.aiBarOpen) return u.setAiBarOpen(false);
        if (u.compose) return u.closeCompose();
        if (mail().openThreadId) return mail().closeThread();
        if (u.screen !== "mail") return u.setScreen("mail");
      },
    },
  ];
}

/** Bindings for the keyboard engine, honoring user remaps from settings. */
export function commandBindings(): Binding[] {
  const shortcuts = useSettings.getState().settings.shortcuts;
  return allCommands()
    .map((c) => ({
      expr: shortcuts[c.id] ?? "",
      run: () => void c.run(),
      when: c.when,
      bypassOverlays: c.id === "palette.open",
    }))
    .filter((b) => b.expr !== "");
}

export function shortcutHint(commandId: string): string {
  return useSettings.getState().settings.shortcuts[commandId] ?? "";
}
