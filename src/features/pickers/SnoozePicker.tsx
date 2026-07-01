import { useMail } from "@/stores/mail";
import { actionTargetThreadId, useUi } from "@/stores/ui";
import { PickerShell, type PickerItem } from "./PickerShell";

function at(hour: number, dayOffset: number): number {
  const d = new Date();
  d.setDate(d.getDate() + dayOffset);
  d.setHours(hour, 0, 0, 0);
  return d.getTime();
}

export function SnoozePicker() {
  const id = actionTargetThreadId();

  const snooze = (until: number, label: string) => async () => {
    if (!id) return;
    if (useMail.getState().openThreadId === id) useMail.getState().closeThread();
    await useMail.getState().snooze(id, until);
    useUi.getState().showToast(`Reminder set — ${label}`);
    await useUi.getState().checkInboxZero();
  };

  const now = new Date();
  const items: PickerItem[] = [
    {
      label: "In 2 hours",
      detail: new Date(Date.now() + 2 * 3600_000).toLocaleTimeString(undefined, {
        hour: "numeric",
        minute: "2-digit",
      }),
      run: snooze(Date.now() + 2 * 3600_000, "in 2 hours"),
    },
    {
      label: "This evening",
      detail: "6:00 PM",
      run: snooze(at(18, now.getHours() >= 18 ? 1 : 0), "this evening"),
    },
    { label: "Tomorrow morning", detail: "8:00 AM", run: snooze(at(8, 1), "tomorrow") },
    { label: "This weekend", detail: "Sat 8:00 AM", run: snooze(at(8, (6 - now.getDay() + 7) % 7 || 7), "this weekend") },
    { label: "Next week", detail: "Mon 8:00 AM", run: snooze(at(8, (1 - now.getDay() + 7) % 7 || 7), "next week") },
    { label: "In 30 seconds (demo)", detail: "for testing", run: snooze(Date.now() + 30_000, "in 30 seconds") },
  ];

  return <PickerShell title="Remind me…" items={items} />;
}
