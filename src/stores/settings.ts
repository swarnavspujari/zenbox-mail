import { create } from "zustand";
import { backend } from "@/lib/ipc";
import { defaultKnowledgeBase, defaultSettings } from "@/lib/defaults";
import type {
  AccountInfo,
  AccountsState,
  AiProviderId,
  KnowledgeBase,
  ProfileInfo,
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

/** Cached account profiles (name + photo) for the header and settings. */
interface ProfilesState {
  profiles: Record<string, ProfileInfo>;
  loadFor: (email: string) => Promise<void>;
  setPhoto: (email: string, picture: string | null) => Promise<void>;
}

export const useProfiles = create<ProfilesState>((set, get) => ({
  profiles: {},
  loadFor: async (email) => {
    if (get().profiles[email]) return;
    const p = await backend.getProfile(email).catch(() => null);
    if (p) set((s) => ({ profiles: { ...s.profiles, [email]: p } }));
  },
  setPhoto: async (email, picture) => {
    await backend.setProfilePhoto(email, picture);
    const p = (await backend.getProfile(email).catch(() => null)) ?? {
      name: email,
      picture,
    };
    set((s) => ({ profiles: { ...s.profiles, [email]: p } }));
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
