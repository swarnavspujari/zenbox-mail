import { useEffect, useState } from "react";
import { backend } from "@/lib/ipc";
import { useMail } from "@/stores/mail";
import { actionTargetThreadId, useUi } from "@/stores/ui";
import { PickerShell, type PickerItem } from "./PickerShell";

export function MovePicker() {
  const [labels, setLabels] = useState<string[]>([]);
  const id = actionTargetThreadId();

  useEffect(() => {
    void backend.listLabels().then(setLabels);
  }, []);

  const items: PickerItem[] = labels.map((label) => ({
    label,
    run: async () => {
      if (!id) return;
      await useMail.getState().moveLabel(id, label);
      useUi.getState().showToast(`Toggled label "${label}"`);
    },
  }));

  return <PickerShell title="Move to folder / label" items={items} filterable />;
}
