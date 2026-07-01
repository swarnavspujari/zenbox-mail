import { create } from "zustand";
import { backend } from "@/lib/ipc";
import { defaultKnowledgeBase, defaultSettings } from "@/lib/defaults";
import type {
  AccountInfo,
  AiProviderId,
  KnowledgeBase,
  Settings,
  Streaks,
} from "@/lib/types";

interface SettingsState {
  loaded: boolean;
  account: AccountInfo | null;
  settings: Settings;
  kb: KnowledgeBase;
  streaks: Streaks;

  load: () => Promise<void>;
  save: (patch: Partial<Settings>) => Promise<void>;
  saveKb: (kb: KnowledgeBase) => Promise<void>;
  setAiKey: (provider: AiProviderId, key: string) => Promise<void>;
  refreshAccount: () => Promise<void>;
}

export const useSettings = create<SettingsState>((set, get) => ({
  loaded: false,
  account: null,
  settings: defaultSettings(),
  kb: defaultKnowledgeBase(),
  streaks: { daily: 0, weekly: 0, lastZeroDay: null },

  load: async () => {
    const [settings, kb, streaks, account] = await Promise.all([
      backend.getSettings(),
      backend.getKnowledgeBase(),
      backend.getStreaks(),
      backend.getAccount(),
    ]);
    set({ settings, kb, streaks, account, loaded: true });
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

  refreshAccount: async () => {
    set({ account: await backend.getAccount() });
  },
}));
