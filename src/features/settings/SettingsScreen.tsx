import { useEffect, useState } from "react";
import { backend, isTauri } from "@/lib/ipc";
import { formatKeyExpr } from "@/lib/keyboard";
import { allCommands } from "@/lib/commands";
import { useUpdater } from "@/lib/updater";
import { useMail } from "@/stores/mail";
import { useProfiles, useSettings } from "@/stores/settings";
import { useUi } from "@/stores/ui";
import { Avatar } from "@/components/Avatar";
import { SignatureEditor } from "./SignatureEditor";
import type {
  AiProviderId,
  Split,
  SplitField,
  SplitOp,
} from "@/lib/types";

const TABS = [
  ["account", "Account"],
  ["ai", "AI Providers"],
  ["knowledge", "Knowledge Base"],
  ["splits", "Splits"],
  ["shortcuts", "Shortcuts"],
  ["celebration", "Inbox Zero"],
  ["appearance", "Appearance"],
] as const;

const inputCls =
  "w-full rounded-md border border-line-strong bg-raised px-3 py-2 text-[13px] text-ink outline-none placeholder:text-ink-3 focus:border-accent";
const btnCls =
  "rounded-md bg-accent px-3 py-1.5 text-[12.5px] font-medium text-on-accent hover:bg-accent-strong disabled:opacity-50";
const btnGhost =
  "rounded-md border border-line-strong px-3 py-1.5 text-[12.5px] text-ink-2 hover:bg-hover";

function Section({
  title,
  children,
  hint,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mb-8">
      <h2 className="mb-1 text-[14px] font-semibold text-ink">{title}</h2>
      {hint && <p className="mb-3 text-[12px] text-ink-3">{hint}</p>}
      {children}
    </div>
  );
}

// ---------------------------------------------------------------- Account

/** Header avatar with an override: click to pick a new photo, × resets to
 *  the Google one (or the monogram). */
function ProfilePhoto({ email }: { email: string }) {
  const profile = useProfiles((s) => s.profiles[email]);
  const [hover, setHover] = useState(false);

  useEffect(() => {
    void useProfiles.getState().loadFor(email);
  }, [email]);

  const pick = () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.onchange = () => {
      const f = input.files?.[0];
      if (!f || f.size > 1_000_000) {
        if (f) window.alert("Keep the photo under 1 MB.");
        return;
      }
      const r = new FileReader();
      r.onload = () =>
        void useProfiles.getState().setPhoto(email, String(r.result));
      r.readAsDataURL(f);
    };
    input.click();
  };

  return (
    <span
      className="relative cursor-pointer"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={pick}
      title="Click to change the photo"
    >
      <Avatar name={profile?.name ?? email} email={email} src={profile?.picture} size={28} />
      {hover && profile?.picture && (
        <button
          className="absolute -right-1.5 -top-1.5 flex h-4 w-4 items-center justify-center rounded-full bg-overlay text-[10px] text-ink-2 shadow"
          onClick={(e) => {
            e.stopPropagation();
            void useProfiles.getState().setPhoto(email, null);
          }}
          title="Remove custom photo"
        >
          ×
        </button>
      )}
    </span>
  );
}

function AccountTab() {
  const accounts = useSettings((s) => s.accounts);
  const settings = useSettings((s) => s.settings);
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [clientStored, setClientStored] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [sigDrafts, setSigDrafts] = useState<Record<string, string>>({});

  useEffect(() => {
    void backend.hasGmailClient().then(setClientStored);
  }, []);

  const connect = async () => {
    setBusy(true);
    setMsg(null);
    try {
      // blank fields reuse the client already in the keychain
      await backend.startOauth(clientId.trim(), clientSecret.trim());
      await useSettings.getState().refreshAccounts();
      await backend.syncNow();
      await useMail.getState().refresh();
      setMsg("Connected. Syncing the inbox…");
      setClientId("");
      setClientSecret("");
    } catch (e) {
      setMsg(String(e));
    } finally {
      setBusy(false);
    }
  };

  const move = (index: number, dir: -1 | 1) => {
    const emails = accounts.accounts.map((a) => a.email);
    const j = index + dir;
    if (j < 0 || j >= emails.length) return;
    [emails[index], emails[j]] = [emails[j], emails[index]];
    void useSettings.getState().reorderAccounts(emails);
  };

  const saveSignature = (email: string) => {
    void useSettings.getState().save({
      signatures: { ...settings.signatures, [email]: sigDrafts[email] ?? "" },
    });
  };

  return (
    <>
      <Section
        title="Accounts"
        hint="Slot number = Alt+1…9 to switch instantly. Reorder to reassign slots. Each account gets its own signature."
      >
        <div className="space-y-3">
          {accounts.accounts.map((a, i) => {
            const active = a.email === accounts.active;
            const sig = sigDrafts[a.email] ?? settings.signatures[a.email] ?? "";
            const sigDirty =
              (sigDrafts[a.email] ?? null) !== null &&
              sigDrafts[a.email] !== (settings.signatures[a.email] ?? "");
            return (
              <div key={a.email} className="rounded-lg border border-line bg-surface p-3">
                <div className="flex items-center gap-3">
                  <span className="kbd">Alt+{i + 1}</span>
                  <ProfilePhoto email={a.email} />
                  <div className={`h-2 w-2 rounded-full ${a.connected ? "bg-ok" : "bg-warn"}`} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] text-ink">
                      {a.email}
                      {active && (
                        <span className="ml-2 rounded bg-accent-dim px-1.5 py-0.5 text-[10.5px] text-accent-strong">
                          active
                        </span>
                      )}
                    </div>
                    <div className="text-[11.5px] capitalize text-ink-3">
                      {a.provider === "mock" ? "demo data" : a.provider}
                    </div>
                  </div>
                  <button className={btnGhost} onClick={() => move(i, -1)} disabled={i === 0} title="Move up (lower slot)">
                    ↑
                  </button>
                  <button
                    className={btnGhost}
                    onClick={() => move(i, 1)}
                    disabled={i === accounts.accounts.length - 1}
                    title="Move down (higher slot)"
                  >
                    ↓
                  </button>
                  {!active && (
                    <button
                      className={btnGhost}
                      onClick={() =>
                        void useSettings
                          .getState()
                          .switchAccount(a.email)
                          .then(() => useMail.getState().refresh())
                      }
                    >
                      Switch
                    </button>
                  )}
                  {a.provider === "gmail" && (
                    <button
                      className={btnGhost}
                      onClick={async () => {
                        await backend.disconnect(a.email);
                        await useSettings.getState().refreshAccounts();
                        await useMail.getState().refresh();
                      }}
                    >
                      Disconnect
                    </button>
                  )}
                </div>
                <div className="mt-2">
                  <SignatureEditor
                    value={sig}
                    onChange={(html) =>
                      setSigDrafts((d) => ({ ...d, [a.email]: html }))
                    }
                  />
                  {sigDirty && (
                    <button className={`${btnCls} mt-1.5`} onClick={() => saveSignature(a.email)}>
                      Save signature
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </Section>

      <Section
        title="Add a Gmail account"
        hint={
          clientStored
            ? "Your OAuth client is already in the Windows Credential Manager — leave the fields blank and hit Connect. Add as many Gmail accounts as you like with the same client."
            : "Paste the OAuth client from Google Cloud Console (Desktop app type, Gmail API enabled — step-by-step in docs/SETUP.md). It's stored in the Windows Credential Manager, never on disk."
        }
      >
        <div className="space-y-2">
          <input
            className={inputCls}
            placeholder={clientStored ? "Client ID (stored — leave blank to reuse)" : "Client ID (…apps.googleusercontent.com)"}
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
          />
          <input
            className={inputCls}
            type="password"
            placeholder={clientStored ? "Client secret (stored — leave blank to reuse)" : "Client secret"}
            value={clientSecret}
            onChange={(e) => setClientSecret(e.target.value)}
          />
          <div className="flex items-center gap-3">
            <button
              className={btnCls}
              disabled={busy || !isTauri || (!clientStored && (!clientId.trim() || !clientSecret.trim()))}
              onClick={connect}
            >
              {busy ? "Waiting for browser consent…" : "Connect Gmail"}
            </button>
            {!isTauri && (
              <span className="text-[12px] text-warn">
                OAuth needs the desktop app — this is the browser demo.
              </span>
            )}
            {msg && <span className="text-[12px] text-ink-2">{msg}</span>}
          </div>
        </div>
      </Section>

      <Section
        title="Add an Outlook account"
        hint="Microsoft Graph support is scaffolded and lands next release. It will use an Azure app registration (public client + PKCE, Mail.ReadWrite + Mail.Send) the same way Gmail uses its OAuth client — setup steps are already drafted in docs/SETUP.md."
      >
        <button className={btnGhost} disabled>
          Coming next release
        </button>
      </Section>
    </>
  );
}

// ---------------------------------------------------------------- AI

function AiTab() {
  const settings = useSettings((s) => s.settings);
  const [keys, setKeys] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<Record<string, string>>({});

  const saveKey = async (id: AiProviderId) => {
    const key = keys[id] ?? "";
    await useSettings.getState().setAiKey(id, key);
    setKeys((k) => ({ ...k, [id]: "" }));
    setStatus((s) => ({ ...s, [id]: "Key saved to OS keychain." }));
  };

  const test = async (id: AiProviderId) => {
    setStatus((s) => ({ ...s, [id]: "Testing…" }));
    try {
      const r = await backend.testAiProvider(id);
      setStatus((s) => ({ ...s, [id]: `${r.ok ? "✓" : "✗"} ${r.message}` }));
    } catch (e) {
      setStatus((s) => ({ ...s, [id]: `✗ ${String(e)}` }));
    }
  };

  const patchProvider = (id: AiProviderId, patch: Partial<(typeof settings.providers)[number]>) => {
    void useSettings.getState().save({
      providers: settings.providers.map((p) =>
        p.id === id ? { ...p, ...patch } : p
      ),
    });
  };

  return (
    <>
      <Section
        title="Bring your own key"
        hint="Keys are stored in the Windows Credential Manager and only ever sent to the provider you chose. They never appear in logs or the repo."
      >
        <div className="space-y-4">
          {settings.providers.map((p) => (
            <div key={p.id} className="rounded-lg border border-line bg-surface p-4">
              <div className="mb-2 flex items-center gap-2">
                <label className="flex items-center gap-2 text-[13.5px] font-medium text-ink">
                  <input
                    type="radio"
                    name="defaultProvider"
                    checked={settings.defaultAiProvider === p.id}
                    onChange={() =>
                      void useSettings.getState().save({ defaultAiProvider: p.id })
                    }
                    className="accent-[#6d7ff2]"
                  />
                  {p.label}
                </label>
                {settings.defaultAiProvider === p.id && (
                  <span className="rounded bg-accent-dim px-1.5 py-0.5 text-[10.5px] text-accent-strong">
                    default
                  </span>
                )}
                <div className="flex-1" />
                <span
                  className={`text-[11.5px] ${p.hasKey ? "text-ok" : "text-ink-3"}`}
                >
                  {p.hasKey ? "key stored" : "no key"}
                </span>
              </div>
              <div className="flex gap-2">
                <input
                  className={inputCls}
                  type="password"
                  placeholder={
                    p.id === "claude"
                      ? "sk-ant-…"
                      : p.id === "openai"
                        ? "sk-…"
                        : "nvapi-…"
                  }
                  value={keys[p.id] ?? ""}
                  onChange={(e) =>
                    setKeys((k) => ({ ...k, [p.id]: e.target.value }))
                  }
                />
                <button
                  className={btnCls}
                  disabled={!(keys[p.id] ?? "").trim()}
                  onClick={() => void saveKey(p.id)}
                >
                  Save
                </button>
                <button className={btnGhost} onClick={() => void test(p.id)}>
                  Test connection
                </button>
              </div>
              <div className="mt-2 flex gap-2">
                <input
                  className={inputCls}
                  value={p.model}
                  onChange={(e) => patchProvider(p.id, { model: e.target.value })}
                  title="Model"
                />
                {p.id === "nim" && (
                  <input
                    className={inputCls}
                    value={p.baseUrl ?? ""}
                    onChange={(e) =>
                      patchProvider(p.id, { baseUrl: e.target.value })
                    }
                    placeholder="Base URL (hosted or self-hosted NIM)"
                    title="OpenAI-compatible base URL"
                  />
                )}
              </div>
              {status[p.id] && (
                <div className="mt-2 text-[12px] text-ink-2">{status[p.id]}</div>
              )}
            </div>
          ))}
        </div>
      </Section>
    </>
  );
}

// ---------------------------------------------------------------- Knowledge

function KnowledgeTab() {
  const kb = useSettings((s) => s.kb);
  const [draft, setDraft] = useState(kb.instructions);
  const [snipTitle, setSnipTitle] = useState("");
  const [snipBody, setSnipBody] = useState("");
  const [exTitle, setExTitle] = useState("");
  const [exBody, setExBody] = useState("");

  const save = (patch: Partial<typeof kb>) =>
    void useSettings.getState().saveKb({ ...kb, ...patch });

  return (
    <>
      <Section
        title="Standing instructions"
        hint="How the AI should sound and rules it must always follow. Injected into every draft."
      >
        <textarea
          className={`${inputCls} min-h-28 resize-y`}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={'e.g. "Be warm but brief. Never use exclamation marks. Sign off with just \'S\'. When scheduling, always propose two concrete times."'}
        />
        <div className="mt-2 flex items-center gap-3">
          <button className={btnCls} onClick={() => save({ instructions: draft })}>
            Save instructions
          </button>
          {draft !== kb.instructions && (
            <span className="text-[12px] text-warn">unsaved changes</span>
          )}
        </div>
      </Section>

      <Section
        title="Snippets"
        hint="Reusable blocks the AI can weave into drafts (bios, disclaimers, scheduling links…)."
      >
        <div className="mb-3 space-y-2">
          {kb.snippets.map((s) => (
            <div
              key={s.id}
              className="flex items-start gap-3 rounded-md border border-line bg-surface px-3 py-2"
            >
              <div className="min-w-0 flex-1">
                <div className="text-[13px] font-medium text-ink">{s.title}</div>
                <div className="truncate text-[12px] text-ink-3">{s.body}</div>
              </div>
              <button
                className="text-[12px] text-ink-3 hover:text-bad"
                onClick={() =>
                  save({ snippets: kb.snippets.filter((x) => x.id !== s.id) })
                }
              >
                remove
              </button>
            </div>
          ))}
        </div>
        <div className="space-y-2">
          <input
            className={inputCls}
            placeholder="Snippet title"
            value={snipTitle}
            onChange={(e) => setSnipTitle(e.target.value)}
          />
          <textarea
            className={`${inputCls} min-h-16 resize-y`}
            placeholder="Snippet text"
            value={snipBody}
            onChange={(e) => setSnipBody(e.target.value)}
          />
          <button
            className={btnCls}
            disabled={!snipTitle.trim() || !snipBody.trim()}
            onClick={() => {
              save({
                snippets: [
                  ...kb.snippets,
                  { id: `snip-${Date.now()}`, title: snipTitle, body: snipBody },
                ],
              });
              setSnipTitle("");
              setSnipBody("");
            }}
          >
            Add snippet
          </button>
        </div>
      </Section>

      <Section
        title="Voice examples"
        hint="Paste emails you've written that sound like you. The AI mimics their tone and structure."
      >
        <div className="mb-3 space-y-2">
          {kb.voiceExamples.map((s) => (
            <div
              key={s.id}
              className="flex items-start gap-3 rounded-md border border-line bg-surface px-3 py-2"
            >
              <div className="min-w-0 flex-1">
                <div className="text-[13px] font-medium text-ink">{s.title}</div>
                <div className="truncate text-[12px] text-ink-3">{s.body}</div>
              </div>
              <button
                className="text-[12px] text-ink-3 hover:text-bad"
                onClick={() =>
                  save({
                    voiceExamples: kb.voiceExamples.filter((x) => x.id !== s.id),
                  })
                }
              >
                remove
              </button>
            </div>
          ))}
        </div>
        <div className="space-y-2">
          <input
            className={inputCls}
            placeholder='Label, e.g. "how I decline pitches"'
            value={exTitle}
            onChange={(e) => setExTitle(e.target.value)}
          />
          <textarea
            className={`${inputCls} min-h-24 resize-y`}
            placeholder="Paste the example email"
            value={exBody}
            onChange={(e) => setExBody(e.target.value)}
          />
          <button
            className={btnCls}
            disabled={!exTitle.trim() || !exBody.trim()}
            onClick={() => {
              save({
                voiceExamples: [
                  ...kb.voiceExamples,
                  { id: `ex-${Date.now()}`, title: exTitle, body: exBody },
                ],
              });
              setExTitle("");
              setExBody("");
            }}
          >
            Add example
          </button>
        </div>
      </Section>
    </>
  );
}

// ---------------------------------------------------------------- Splits

function SplitsTab() {
  const settings = useSettings((s) => s.settings);
  const [name, setName] = useState("");
  const [op, setOp] = useState<SplitOp>("or");
  const [rules, setRules] = useState<{ field: SplitField; contains: string }[]>([
    { field: "from", contains: "" },
  ]);

  const saveSplits = (splits: Split[]) =>
    void useSettings.getState().save({ splits });

  const addSplit = () => {
    const clean = rules.filter((r) => r.contains.trim());
    if (!name.trim() || clean.length === 0) return;
    const split: Split = {
      id: `custom-${Date.now()}`,
      name: name.trim(),
      builtin: false,
      rules: clean,
      op,
      hideWhenEmpty: false,
    };
    // custom splits match before the catch-all "Other"
    const otherIdx = settings.splits.findIndex((s) => s.rules.length === 0);
    const splits = [...settings.splits];
    splits.splice(otherIdx === -1 ? splits.length : otherIdx, 0, split);
    saveSplits(splits);
    setName("");
    setRules([{ field: "from", contains: "" }]);
  };

  return (
    <>
      <Section
        title="Split inboxes"
        hint="Splits divide the inbox into focused tabs. Counts show total conversations (not just unread). Tab / Shift+Tab cycles between them."
      >
        <div className="space-y-2">
          {settings.splits.map((s) => (
            <div
              key={s.id}
              className="flex items-center gap-3 rounded-md border border-line bg-surface px-3 py-2"
            >
              <span className="text-[13px] font-medium text-ink">{s.name}</span>
              <span className="text-[11.5px] text-ink-3">
                {s.rules.length === 0
                  ? "catch-all"
                  : s.rules
                      .map((r) => `${r.field}:"${r.contains}"`)
                      .join(s.op === "and" ? " AND " : " OR ")}
              </span>
              <div className="flex-1" />
              <label className="flex items-center gap-1.5 text-[11.5px] text-ink-3">
                <input
                  type="checkbox"
                  checked={s.hideWhenEmpty}
                  onChange={(e) =>
                    saveSplits(
                      settings.splits.map((x) =>
                        x.id === s.id
                          ? { ...x, hideWhenEmpty: e.target.checked }
                          : x
                      )
                    )
                  }
                  className="accent-[#6d7ff2]"
                />
                hide when empty
              </label>
              {!s.builtin && (
                <button
                  className="text-[12px] text-ink-3 hover:text-bad"
                  onClick={() =>
                    saveSplits(settings.splits.filter((x) => x.id !== s.id))
                  }
                >
                  remove
                </button>
              )}
            </div>
          ))}
        </div>
      </Section>

      <Section title="New custom split">
        <div className="space-y-2">
          <input
            className={inputCls}
            placeholder='Split name, e.g. "Portfolio"'
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          {rules.map((r, i) => (
            <div key={i} className="flex gap-2">
              <select
                className="rounded-md border border-line-strong bg-raised px-2 py-2 text-[13px] text-ink"
                value={r.field}
                onChange={(e) =>
                  setRules(
                    rules.map((x, j) =>
                      j === i ? { ...x, field: e.target.value as SplitField } : x
                    )
                  )
                }
              >
                <option value="from">from</option>
                <option value="to">to</option>
                <option value="subject">subject</option>
                <option value="label">label</option>
              </select>
              <input
                className={inputCls}
                placeholder="contains…"
                value={r.contains}
                onChange={(e) =>
                  setRules(
                    rules.map((x, j) =>
                      j === i ? { ...x, contains: e.target.value } : x
                    )
                  )
                }
              />
              {rules.length > 1 && (
                <button
                  className={btnGhost}
                  onClick={() => setRules(rules.filter((_, j) => j !== i))}
                >
                  ✕
                </button>
              )}
            </div>
          ))}
          <div className="flex items-center gap-3">
            <button
              className={btnGhost}
              onClick={() => setRules([...rules, { field: "from", contains: "" }])}
            >
              + rule
            </button>
            <label className="flex items-center gap-2 text-[12.5px] text-ink-2">
              combine with
              <select
                className="rounded-md border border-line-strong bg-raised px-2 py-1 text-[12.5px] text-ink"
                value={op}
                onChange={(e) => setOp(e.target.value as SplitOp)}
              >
                <option value="or">OR</option>
                <option value="and">AND</option>
              </select>
            </label>
            <div className="flex-1" />
            <button className={btnCls} onClick={addSplit}>
              Create split
            </button>
          </div>
        </div>
      </Section>
    </>
  );
}

// ---------------------------------------------------------------- Shortcuts

function ShortcutsTab() {
  const shortcuts = useSettings((s) => s.settings.shortcuts);
  const [editing, setEditing] = useState<string | null>(null);
  const [expr, setExpr] = useState("");

  const commands = allCommands();

  return (
    <Section
      title="Keyboard shortcuts"
      hint='Click a binding to remap. Format: single keys ("e"), combos ("mod+k"), chords ("g i"), alternatives ("j|down"). "mod" is Ctrl on Windows.'
    >
      <div className="overflow-hidden rounded-lg border border-line">
        {commands.map((c) => (
          <div
            key={c.id}
            className="flex items-center gap-3 border-b border-line bg-surface px-4 py-2 last:border-b-0"
          >
            <span className="flex-1 text-[13px] text-ink">{c.title}</span>
            {editing === c.id ? (
              <input
                autoFocus
                className="w-40 rounded-md border border-accent bg-raised px-2 py-1 text-[12.5px] text-ink outline-none"
                value={expr}
                onChange={(e) => setExpr(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    void useSettings.getState().save({
                      shortcuts: { ...shortcuts, [c.id]: expr.trim() },
                    });
                    setEditing(null);
                  }
                  if (e.key === "Escape") setEditing(null);
                  e.stopPropagation();
                }}
                onBlur={() => setEditing(null)}
              />
            ) : (
              <button
                className="kbd hover:border-accent"
                onClick={() => {
                  setEditing(c.id);
                  setExpr(shortcuts[c.id] ?? "");
                }}
              >
                {shortcuts[c.id] ? formatKeyExpr(shortcuts[c.id]) : "unbound"}
              </button>
            )}
          </div>
        ))}
      </div>
    </Section>
  );
}

// ---------------------------------------------------------------- Celebration

function CelebrationTab() {
  const settings = useSettings((s) => s.settings);
  const streaks = useSettings((s) => s.streaks);
  const [dir, setDir] = useState(settings.celebrationDir ?? "");

  return (
    <>
      <Section title="Streak">
        <div className="flex gap-4">
          <div className="flex-1 rounded-lg border border-line bg-surface px-4 py-3 text-center">
            <div className="text-2xl font-semibold text-ink">{streaks.daily}</div>
            <div className="text-[11.5px] text-ink-3">day streak</div>
          </div>
          <div className="flex-1 rounded-lg border border-line bg-surface px-4 py-3 text-center">
            <div className="text-2xl font-semibold text-ink">{streaks.weekly}</div>
            <div className="text-[11.5px] text-ink-3">week streak</div>
          </div>
        </div>
      </Section>
      <Section
        title="Celebration images"
        hint="Shown full-screen when a split hits zero. Leave empty to use the bundled set, or point to a folder of your own images."
      >
        <div className="flex gap-2">
          <input
            className={inputCls}
            placeholder="C:\\Users\\you\\Pictures\\celebrations (empty = bundled)"
            value={dir}
            onChange={(e) => setDir(e.target.value)}
          />
          <button
            className={btnCls}
            onClick={() =>
              void useSettings.getState().save({
                celebrationDir: dir.trim() ? dir.trim() : null,
              })
            }
          >
            Save
          </button>
        </div>
      </Section>
    </>
  );
}

// ---------------------------------------------------------------- Appearance

/** Manual update check + status. Auto-update also runs on boot / focus / every
 *  4h; this surfaces the state (and any failure, which used to be invisible). */
function UpdateControls() {
  const status = useUpdater((s) => s.status);
  const checking = useUpdater((s) => s.checking);
  const ready = useUpdater((s) => s.ready);
  const downloading = useUpdater((s) => s.downloading);
  const error = useUpdater((s) => s.error);
  return (
    <div className="flex flex-wrap items-center gap-3">
      {ready ? (
        <button className={btnCls} onClick={() => void useUpdater.getState().restart()}>
          Restart to install {ready}
        </button>
      ) : (
        <button
          className={btnGhost}
          disabled={checking || !!downloading}
          onClick={() => void useUpdater.getState().checkNow()}
        >
          {checking ? "Checking…" : downloading ? "Downloading…" : "Check for updates"}
        </button>
      )}
      {status && (
        <span className={`text-[12px] ${error ? "text-warn" : "text-ink-3"}`}>
          {status}
        </span>
      )}
    </div>
  );
}

function AppearanceTab() {
  const theme = useSettings((s) => s.settings.theme);
  const notifications = useSettings((s) => s.settings.notifications);
  const onboarded = useSettings((s) => s.settings.onboarded);
  return (
    <>
      <Section
        title="Theme"
        hint="Dark is the default and follows Superhuman's dark-theme principles. Light is tuned for perceptual contrast, not just inverted."
      >
        <div className="flex gap-3">
          {(["dark", "light"] as const).map((t) => (
            <label
              key={t}
              className={`flex flex-1 cursor-pointer items-center gap-3 rounded-lg border px-4 py-3 ${
                theme === t ? "border-accent bg-accent-dim" : "border-line bg-surface"
              }`}
            >
              <input
                type="radio"
                name="theme"
                checked={theme === t}
                onChange={() => void useSettings.getState().save({ theme: t })}
                className="accent-[#6d7ff2]"
              />
              <span className="text-[13px] capitalize text-ink">{t}</span>
            </label>
          ))}
        </div>
      </Section>

      <Section
        title="Notifications"
        hint="New-mail notifications appear only while the Fission window is in the background."
      >
        <label className="flex cursor-pointer items-center gap-3">
          <input
            type="checkbox"
            checked={notifications}
            onChange={(e) =>
              void useSettings.getState().save({ notifications: e.target.checked })
            }
            className="accent-[#6d7ff2]"
          />
          <span className="text-[13px] text-ink">Notify me about new mail</span>
        </label>
      </Section>

      <Section
        title="Welcome tour"
        hint="Replay the first-run walkthrough (connect, AI, theme, shortcuts)."
      >
        <button
          className={btnGhost}
          onClick={() => {
            void useSettings.getState().save({ onboarded: false });
            useUi.getState().setScreen("mail");
          }}
        >
          {onboarded ? "Show the welcome tour again" : "Tour will show on the mail screen"}
        </button>
      </Section>

      <Section
        title="Updates"
        hint="Updates install themselves from GitHub Releases — on launch, when you refocus the window, and every few hours. Check manually here; failures show up instead of failing silently."
      >
        <UpdateControls />
      </Section>
    </>
  );
}

// ---------------------------------------------------------------- shell

export function SettingsScreen() {
  const tab = useUi((s) => s.settingsTab);

  return (
    <div className="flex h-full">
      <nav className="w-52 shrink-0 border-r border-line bg-surface py-3">
        {TABS.map(([id, label]) => (
          <button
            key={id}
            onClick={() => useUi.getState().setSettingsTab(id)}
            className={`block w-full px-5 py-2 text-left text-[13px] ${
              tab === id
                ? "bg-selected font-medium text-ink"
                : "text-ink-2 hover:bg-hover"
            }`}
          >
            {label}
          </button>
        ))}
        <div className="mt-4 px-5 text-[11px] text-ink-3">
          <span className="kbd">Esc</span> back to inbox
        </div>
      </nav>
      <div className="min-w-0 flex-1 overflow-y-auto px-8 py-6">
        <div className="max-w-2xl">
          {tab === "account" && <AccountTab />}
          {tab === "ai" && <AiTab />}
          {tab === "knowledge" && <KnowledgeTab />}
          {tab === "splits" && <SplitsTab />}
          {tab === "shortcuts" && <ShortcutsTab />}
          {tab === "celebration" && <CelebrationTab />}
          {tab === "appearance" && <AppearanceTab />}
        </div>
      </div>
    </div>
  );
}
