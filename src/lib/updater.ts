// Auto-update: check GitHub Releases on boot (and every 4h), download in the
// background, then offer a one-click restart. No-op in the browser demo.
import { create } from "zustand";
import { isTauri } from "./ipc";

interface UpdateState {
  /** Version string when an update is downloaded and ready to install. */
  ready: string | null;
  /** Non-null while downloading. */
  downloading: string | null;
  error: string | null;
  restart: () => Promise<void>;
}

export const useUpdater = create<UpdateState>(() => ({
  ready: null,
  downloading: null,
  error: null,
  restart: async () => {
    const { relaunch } = await import("@tauri-apps/plugin-process");
    await relaunch();
  },
}));

async function checkOnce(): Promise<void> {
  const { check } = await import("@tauri-apps/plugin-updater");
  const update = await check();
  if (!update) return;
  useUpdater.setState({ downloading: update.version });
  await update.downloadAndInstall();
  useUpdater.setState({ downloading: null, ready: update.version });
}

/** Call once at app boot. Safe in the browser (does nothing). */
export function startUpdateChecks(): void {
  if (!isTauri) return;
  const run = () =>
    checkOnce().catch((e) => {
      // offline or rate-limited — try again next interval
      useUpdater.setState({ downloading: null, error: String(e) });
    });
  void run();
  setInterval(run, 4 * 60 * 60 * 1000);
}
