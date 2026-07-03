import { useEffect, useState } from "react";
import { backend, type MailView } from "@/lib/ipc";
import { useMail } from "@/stores/mail";
import { useSettings } from "@/stores/settings";
import { useUi } from "@/stores/ui";
import { Avatar } from "@/components/Avatar";

interface Folder {
  id: MailView | "drafts";
  name: string;
  sub?: string;
}

const FOLDERS: Folder[] = [
  { id: "inbox", name: "Inbox", sub: "Important · Other" },
  { id: "starred", name: "Starred" },
  { id: "drafts", name: "Drafts" },
  { id: "done", name: "Done" },
  { id: "reminders", name: "Reminders" },
  { id: "trash", name: "Trash" },
];

/** True for Gmail system labels (IMPORTANT, CATEGORY_…) vs user labels. */
function isSystemLabel(l: string): boolean {
  return /^[A-Z_]+$/.test(l);
}

function Item({
  name,
  sub,
  count,
  active,
  onClick,
}: {
  name: string;
  sub?: string;
  count?: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`relative flex w-full items-center gap-2 rounded-md px-2.5 py-[7px] text-left ${
        active ? "bg-selected" : "hover:bg-hover"
      }`}
    >
      {active && (
        <span className="absolute bottom-1.5 left-0 top-1.5 w-[3px] rounded-r bg-accent" />
      )}
      <span
        className={`text-[13.5px] ${
          active ? "font-medium text-ink" : "text-ink-2"
        }`}
      >
        {name}
      </span>
      {sub && <span className="truncate text-[12px] text-ink-3">{sub}</span>}
      <span className="flex-1" />
      {count !== undefined && count > 0 && (
        <span className="text-[12px] tabular-nums text-ink-3">{count}</span>
      )}
    </button>
  );
}

/** Left-hand mailbox navigator: fixed folders + the account's labels. */
export function FolderSidebar() {
  const listView = useMail((s) => s.listView);
  const inboxCount = useMail((s) => s.inbox.length);
  const active = useSettings((s) => s.accounts.active);
  const [labels, setLabels] = useState<string[]>([]);

  useEffect(() => {
    void backend.listLabels().then((all) => {
      setLabels(all.filter((l) => !isSystemLabel(l)));
    });
  }, []);

  const goTo = (view: MailView) => {
    const mail = useMail.getState();
    mail.closeThread();
    mail.setListView(view);
    if (view === "inbox") mail.setActiveSplit("important");
    useUi.getState().setScreen("mail");
  };

  return (
    <nav className="flex w-[244px] shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-line bg-surface px-2 py-3">
      <div className="flex items-center gap-2.5 px-2 pb-3">
        <Avatar name={active} email={active} size={26} />
        <span className="min-w-0 flex-1 truncate text-[13px] text-ink-2">
          {active}
        </span>
      </div>
      {FOLDERS.map((f) =>
        f.id === "drafts" ? (
          <Item
            key={f.id}
            name={f.name}
            active={false}
            onClick={() => useUi.getState().openPicker("drafts")}
          />
        ) : (
          <Item
            key={f.id}
            name={f.name}
            sub={f.sub}
            count={f.id === "inbox" ? inboxCount : undefined}
            active={listView === f.id}
            onClick={() => goTo(f.id as MailView)}
          />
        )
      )}
      {labels.length > 0 && (
        <>
          <div className="px-2.5 pb-1 pt-4 text-[11px] font-medium uppercase tracking-wide text-ink-3">
            Labels
          </div>
          {labels.map((l) => (
            <Item
              key={l}
              name={l}
              active={listView === `label:${l}`}
              onClick={() => goTo(`label:${l}`)}
            />
          ))}
        </>
      )}
    </nav>
  );
}
