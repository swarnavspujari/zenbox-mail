import { create } from "zustand";
import { backend } from "@/lib/ipc";
import { defaultKnowledgeBase, defaultSettings } from "@/lib/defaults";
import type {
  AccountInfo,
  AccountsState,
  AiProviderId,
  KnowledgeBase,
  Settings,
  Streaks,
} from "@/lib/types";

interface SettingsState {
  loaded: boolean;
  accounts: AccountsState;
  settings: Settings;
  kb: KnowledgeBase;
  streaks: Streaks;

  load: () => Promise<void>;
  save: (patch: Partial<Settings>) => Promise<void>;
  saveKb: (kb: KnowledgeBase) => Promise<void>;
  setAiKey: (provider: AiProviderId, key: string) => Promise<void>;
  refreshAccounts: () => Promise<void>;
  switchAccount: (email: string) => Promise<void>;
  reorderAccounts: (emails: string[]) => Promise<void>;
}

export const useSettings = create<SettingsState>((set, get) => ({
  loaded: false,
  accounts: { accounts: [], active: "" },
  settings: defaultSettings(),
  kb: defaultKnowledgeBase(),
  streaks: { daily: 0, weekly: 0, lastZeroDay: null },

  load: async () => {
    const [settings, kb, streaks, accounts] = await Promise.all([
      backend.getSettings(),
      backend.getKnowledgeBase(),
      backend.getStreaks(),
      backend.getAccounts(),
    ]);
    set({ settings, kb, streaks, accounts, loaded: true });
  },

  save: async (patch) => {
    const settings = { ...get().settings, ...patch };
    set({ settings });
    await backend.saveSettings(settings);
  },

  saveKb: async (kb) => {
    set({ kb });
    await backend.saveKnowledgeBase(kb);
  },

  setAiKey: async (provider, key) => {
    await backend.setAiKey(provider, key);
    const settings = await backend.getSettings();
    set({ settings });
  },

  refreshAccounts: async () => {
    set({ accounts: await backend.getAccounts() });
  },

  switchAccount: async (email) => {
    if (email === get().accounts.active) return;
    set({ accounts: await backend.switchAccount(email) });
  },

  reorderAccounts: async (emails) => {
    set({ accounts: await backend.reorderAccounts(emails) });
  },
}));

export function activeAccount(): AccountInfo | undefined {
  const s = useSettings.getState().accounts;
  return s.accounts.find((a) => a.email === s.active) ?? s.accounts[0];
}

export function activeSignature(): string {
  const s = useSettings.getState();
  const email = s.accounts.active;
  return (s.settings.signatures[email] ?? "").trim();
}
