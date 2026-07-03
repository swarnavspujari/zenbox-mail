// Auto-update: check GitHub Releases on boot, every 4h, and on window focus;
// download in the background; offer a one-click restart. Failures used to be
// swallowed (indistinguishable from "no update") — now every outcome is a
// user-facing status. No-op in the browser demo.
import { create } from "zustand";
import { isTauri } from "./ipc";

interface UpdateState {
  /** Version string when an update is downloaded and ready to install. */
  ready: string | null;
  /** Non-null while downloading. */
  downloading: string | null;
  /** A check is in flight. */
  checking: boolean;
  /** Last error reason, if a check/download failed. */
  error: string | null;
  /** Human-facing one-liner: "You're on the latest version", "Downloading vX…". */
  status: string | null;
  restart: () => Promise<void>;
  /** Manual check (Ctrl+K / Settings). Reports the outcome via `status`. */
  checkNow: () => Promise<void>;
}

export const useUpdater = create<UpdateState>((set, get) => ({
  ready: null,
  downloading: null,
  checking: false,
  error: null,
  status: null,
  restart: async () => {
    const { relaunch } = await import("@tauri-apps/plugin-process");
    await relaunch();
  },
  checkNow: async () => {
    if (!isTauri) {
      set({ status: "Updates apply to the installed desktop app." });
      return;
    }
    if (get().checking || get().downloading) return;
    await runCheck(true);
  },
}));

async function runCheck(manual: boolean): Promise<void> {
  // already downloaded and waiting for the user to restart — nothing to do
  if (useUpdater.getState().ready) return;
  useUpdater.setState({
    checking: true,
    error: null,
    ...(manual ? { status: "Checking for updates…" } : {}),
  });
  try {
    const { check } = await import("@tauri-apps/plugin-updater");
    const update = await check();
    if (!update) {
      useUpdater.setState({
        checking: false,
        status: manual ? "You're on the latest version" : useUpdater.getState().status,
      });
      return;
    }
    useUpdater.setState({
      checking: false,
      downloading: update.version,
      status: `Downloading v${update.version}…`,
    });
    await update.downloadAndInstall();
    useUpdater.setState({
      downloading: null,
      ready: update.version,
      status: `Update ready — restart to install v${update.version}`,
    });
  } catch (e) {
    // Surface it: a silently-failing update was exactly the user's experience.
    useUpdater.setState({
      checking: false,
      downloading: null,
      error: String(e),
      status: `Update failed: ${String(e)}`,
    });
  }
}

/** Call once at app boot. Safe in the browser (does nothing). Checks on boot,
 *  every 4h, and when the window regains focus/visibility (throttled), so a user
 *  who reopens the app after a release gets it promptly. */
export function startUpdateChecks(): void {
  if (!isTauri) return;
  void runCheck(false);
  setInterval(() => void runCheck(false), 4 * 60 * 60 * 1000);

  let lastFocusCheck = 0;
  const onResume = () => {
    const now = Date.now();
    if (now - lastFocusCheck < 5 * 60 * 1000) return; // at most every 5 min
    lastFocusCheck = now;
    void runCheck(false);
  };
  window.addEventListener("focus", onResume);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") onResume();
  });
}
