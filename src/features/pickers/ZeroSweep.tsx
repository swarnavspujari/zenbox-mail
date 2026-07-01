import { useMail } from "@/stores/mail";
import { useUi } from "@/stores/ui";
import { PickerShell, type PickerItem } from "./PickerShell";

/** "Get Me To Zero" — bulk archive so the first cleanup doesn't take an hour
 *  of hammering E. Applies to the active split. */
export function ZeroSweep() {
  const run =
    (olderThanDays: number, preserveUnread: boolean, preserveStarred: boolean) =>
    async () => {
      const n = await useMail.getState().bulkArchive({
        olderThanDays,
        preserveUnread,
        preserveStarred,
      });
      useUi.getState().showToast(`Archived ${n} conversation${n === 1 ? "" : "s"}`);
      await useUi.getState().checkInboxZero();
    };

  const items: PickerItem[] = [
    {
      label: "Archive older than 7 days, keep unread + starred",
      detail: "gentle",
      run: run(7, true, true),
    },
    {
      label: "Archive older than 3 days, keep unread + starred",
      run: run(3, true, true),
    },
    {
      label: "Archive older than 7 days, keep starred only",
      run: run(7, false, true),
    },
    {
      label: "Archive everything, keep unread + starred",
      run: run(0, true, true),
    },
    {
      label: "Archive everything in this split",
      detail: "the full sweep",
      run: run(0, false, false),
    },
  ];

  return <PickerShell title="Get Me To Zero — archive this split" items={items} />;
}
