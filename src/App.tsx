import { useEffect } from "react";
import { backend, isTauri } from "@/lib/ipc";
import { commandBindings } from "@/lib/commands";
import { installKeyboard } from "@/lib/keyboard";
import { useMail } from "@/stores/mail";
import { useSettings } from "@/stores/settings";
import { useUi } from "@/stores/ui";
import { MailScreen } from "@/features/inbox/MailScreen";
import { ThreadView } from "@/features/thread/ThreadView";
import { Compose } from "@/features/compose/Compose";
import { CommandPalette } from "@/features/palette/CommandPalette";
import { SnoozePicker } from "@/features/pickers/SnoozePicker";
import { MovePicker } from "@/features/pickers/MovePicker";
import { ZeroSweep } from "@/features/pickers/ZeroSweep";
import { SendLaterPicker } from "@/features/pickers/SendLaterPicker";
import { SnippetPicker } from "@/features/pickers/SnippetPicker";
import { Celebration } from "@/features/zero/Celebration";
import { SearchScreen } from "@/features/search/SearchScreen";
import { SettingsScreen } from "@/features/settings/SettingsScreen";
import { AskAi } from "@/features/thread/AskAi";

export default function App() {
  const screen = useUi((s) => s.screen);
  const paletteOpen = useUi((s) => s.paletteOpen);
  const picker = useUi((s) => s.picker);
  const celebration = useUi((s) => s.celebration);
  const compose = useUi((s) => s.compose);
  const askAiOpen = useUi((s) => s.askAiOpen);
  const toast = useUi((s) => s.toast);
  const openThreadId = useMail((s) => s.openThreadId);
  const loaded = useSettings((s) => s.loaded);
  const accounts = useSettings((s) => s.accounts);
  const theme = useSettings((s) => s.settings.theme);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    void useSettings
      .getState()
      .load()
      .then(() => useMail.getState().refresh());
    const unsub = backend.onMailUpdated(() => void useMail.getState().refresh());
    return unsub;
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
        Loading ZenBox…
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col bg-base">
      <header className="flex h-11 shrink-0 items-center gap-3 border-b border-line bg-surface px-4">
        <span className="text-[15px] font-semibold tracking-tight text-ink">
          ZenBox
        </span>
        {!isTauri && (
          <span className="rounded bg-accent-dim px-2 py-0.5 text-[11px] text-accent-strong">
            demo mode (browser)
          </span>
        )}
        <div className="flex-1" />
        {accounts.accounts.length > 1 ? (
          <select
            value={accounts.active}
            onChange={(e) => {
              void useSettings
                .getState()
                .switchAccount(e.target.value)
                .then(() => useMail.getState().refresh());
            }}
            title="Switch account (Ctrl+1…9)"
            className="rounded-md border border-line bg-raised px-2 py-1 text-[12px] text-ink-2 outline-none hover:border-line-strong"
          >
            {accounts.accounts.map((a, i) => (
              <option key={a.email} value={a.email}>
                {i + 1} · {a.email}
              </option>
            ))}
          </select>
        ) : (
          <span className="text-[12px] text-ink-3">{accounts.active}</span>
        )}
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
        {celebration && <Celebration />}

        {toast && (
          <div className="zb-pop-in pointer-events-none absolute bottom-6 left-1/2 -translate-x-1/2 rounded-md border border-line-strong bg-overlay px-4 py-2 text-[13px] text-ink shadow-lg">
            {toast}
          </div>
        )}
      </main>

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
    </div>
  );
}
