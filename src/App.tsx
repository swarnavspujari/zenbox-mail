import { useEffect } from "react";
import { backend, isTauri } from "@/lib/ipc";
import { commandBindings } from "@/lib/commands";
import { installKeyboard } from "@/lib/keyboard";
import { startUpdateChecks, useUpdater } from "@/lib/updater";
import { useMail } from "@/stores/mail";
import { useProfiles, useSettings } from "@/stores/settings";
import { useUi } from "@/stores/ui";
import { Avatar } from "@/components/Avatar";
import { MailScreen } from "@/features/inbox/MailScreen";
import { ThreadView } from "@/features/thread/ThreadView";
import { Compose } from "@/features/compose/Compose";
import { CommandPalette } from "@/features/palette/CommandPalette";
import { SnoozePicker } from "@/features/pickers/SnoozePicker";
import { MovePicker } from "@/features/pickers/MovePicker";
import { ZeroSweep } from "@/features/pickers/ZeroSweep";
import { SendLaterPicker } from "@/features/pickers/SendLaterPicker";
import { SnippetPicker } from "@/features/pickers/SnippetPicker";
import { DraftsPicker } from "@/features/pickers/DraftsPicker";
import { Celebration } from "@/features/zero/Celebration";
import { SearchScreen } from "@/features/search/SearchScreen";
import { SettingsScreen } from "@/features/settings/SettingsScreen";
import { AskAi } from "@/features/thread/AskAi";
import { Onboarding } from "@/features/onboarding/Onboarding";

function ActiveAvatar({ email }: { email: string }) {
  const profile = useProfiles((s) => s.profiles[email]);
  useEffect(() => {
    if (email) void useProfiles.getState().loadFor(email);
  }, [email]);
  if (!email) return null;
  return (
    <Avatar
      name={profile?.name ?? email}
      email={email}
      src={profile?.picture}
      size={22}
    />
  );
}

export default function App() {
  const screen = useUi((s) => s.screen);
  const paletteOpen = useUi((s) => s.paletteOpen);
  const picker = useUi((s) => s.picker);
  const celebration = useUi((s) => s.celebration);
  const compose = useUi((s) => s.compose);
  const askAiOpen = useUi((s) => s.askAiOpen);
  const toast = useUi((s) => s.toast);
  const openThreadId = useMail((s) => s.openThreadId);
  const updateReady = useUpdater((s) => s.ready);
  const updateDownloading = useUpdater((s) => s.downloading);
  const updateError = useUpdater((s) => s.error);
  const loaded = useSettings((s) => s.loaded);
  const onboarded = useSettings((s) => s.settings.onboarded);
  const accounts = useSettings((s) => s.accounts);
  const theme = useSettings((s) => s.settings.theme);
  const showShortcutBar = useSettings((s) => s.settings.showShortcutBar);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    void useSettings
      .getState()
      .load()
      .then(() => useMail.getState().refresh());
    startUpdateChecks();

    // Reconciliation is debounced: sync / outbox / the 30s loop emit
    // mail:updated at arbitrary times, and a synchronous 4-IPC refresh
    // mid-keystroke was a source of the input lag.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const debouncedRefresh = () => {
      clearTimeout(timer);
      timer = setTimeout(() => void useMail.getState().refresh(), 400);
    };
    const unMail = backend.onMailUpdated(debouncedRefresh);
    // inline images for the open thread resolved in the background — re-read it
    const unImages = backend.onThreadImages((id) => {
      if (useMail.getState().openThreadId === id)
        void useMail.getState().refreshOpenThread();
    });
    // a deferred triage sync to Gmail failed — surface it (not silent)
    const unTriage = backend.onTriageError((msg) =>
      useUi.getState().showToast(msg)
    );
    // general core notices (e.g. a partial OAuth grant at connect time)
    const unNotice = backend.onNotice((msg) => useUi.getState().showToast(msg));
    return () => {
      clearTimeout(timer);
      unMail();
      unImages();
      unTriage();
      unNotice();
    };
  }, []);

  useEffect(() => {
    return installKeyboard({
      getBindings: commandBindings,
      isOverlayOpen: () => {
        const u = useUi.getState();
        return u.paletteOpen || u.picker !== "none" || u.celebration !== null;
      },
    });
  }, []);

  if (!loaded) {
    return (
      <div className="flex h-full items-center justify-center text-ink-3">
        Loading Fission…
      </div>
    );
  }

  if (!onboarded) {
    return (
      <div className="relative h-full bg-base">
        <Onboarding />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col bg-base">
      <header className="flex h-12 shrink-0 items-center gap-3 bg-base px-4">
        <span className="flex items-center gap-2.5">
          <span className="inline-block h-[15px] w-[15px] rotate-45 rounded-[4px] bg-accent" />
          <span className="text-[15px] font-semibold tracking-tight text-ink">
            Fission
          </span>
        </span>
        <div className="flex items-center gap-2 rounded-full border border-line bg-surface py-1 pl-1.5 pr-2 hover:border-line-strong">
          <ActiveAvatar email={accounts.active} />
          <span className="h-1.5 w-1.5 rounded-full bg-ok" title="connected" />
          {accounts.accounts.length > 1 ? (
            <select
              value={accounts.active}
              onChange={(e) => {
                void useSettings
                  .getState()
                  .switchAccount(e.target.value)
                  .then(() => useMail.getState().refresh());
              }}
              title="Switch account (Alt+1…9)"
              className="max-w-56 cursor-pointer appearance-none truncate bg-transparent pr-1 text-[12px] text-ink-2 outline-none"
            >
              {accounts.accounts.map((a, i) => (
                <option key={a.email} value={a.email}>
                  {i + 1} · {a.email}
                </option>
              ))}
            </select>
          ) : (
            <span className="pr-1 text-[12px] text-ink-2">{accounts.active}</span>
          )}
        </div>
        {!isTauri && (
          <span className="rounded bg-accent-dim px-2 py-0.5 text-[11px] text-accent-strong">
            demo mode (browser)
          </span>
        )}
        <div className="flex-1" />
        {updateReady ? (
          <button
            className="zb-pop-in rounded-md bg-accent px-2.5 py-1 text-[12px] font-medium text-on-accent hover:opacity-90"
            onClick={() => void useUpdater.getState().restart()}
            title={`${updateReady} downloaded — restart to apply`}
          >
            Update ready — Restart
          </button>
        ) : updateDownloading ? (
          <span className="rounded-md border border-line px-2.5 py-1 text-[12px] text-ink-3">
            Downloading update…
          </span>
        ) : updateError ? (
          <button
            className="rounded-md border border-line-strong px-2.5 py-1 text-[12px] text-warn hover:bg-hover"
            onClick={() => void useUpdater.getState().checkNow()}
            title={updateError}
          >
            Update failed — Retry
          </button>
        ) : null}
        <button
          className="rounded px-2 py-1 text-[12px] text-ink-2 hover:bg-hover"
          onClick={() => useUi.getState().setScreen("settings")}
        >
          Settings
        </button>
      </header>

      <main className="relative min-h-0 flex-1">
        {screen === "mail" && !openThreadId && <MailScreen />}
        {screen === "mail" && openThreadId && <ThreadView />}
        {screen === "search" && <SearchScreen />}
        {screen === "settings" && <SettingsScreen />}

        {compose && <Compose />}
        {askAiOpen && <AskAi />}
        {paletteOpen && <CommandPalette />}
        {picker === "snooze" && <SnoozePicker />}
        {picker === "move" && <MovePicker />}
        {picker === "zeroSweep" && <ZeroSweep />}
        {picker === "sendLater" && <SendLaterPicker />}
        {picker === "snippet" && <SnippetPicker />}
        {picker === "drafts" && <DraftsPicker />}
        {celebration && <Celebration />}

        {toast && (
          <div className="zb-pop-in pointer-events-none absolute bottom-6 left-1/2 -translate-x-1/2 rounded-md border border-line-strong bg-overlay px-4 py-2 text-[13px] text-ink shadow-lg">
            {toast}
          </div>
        )}
      </main>

      {showShortcutBar && (
        <footer className="flex h-7 shrink-0 items-center gap-4 border-t border-line bg-surface px-4 text-[11px] text-ink-3">
          <span>
            <span className="kbd">Ctrl+K</span> commands
          </span>
          <span>
            <span className="kbd">J</span>/<span className="kbd">K</span> navigate
          </span>
          <span>
            <span className="kbd">E</span> done
          </span>
          <span>
            <span className="kbd">C</span> compose
          </span>
          <span>
            <span className="kbd">Tab</span> next split
          </span>
          <span>
            <span className="kbd">?</span> ask AI
          </span>
        </footer>
      )}
    </div>
  );
}
