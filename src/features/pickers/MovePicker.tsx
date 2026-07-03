import { useEffect, useState } from "react";
import { backend } from "@/lib/ipc";
import { pushTriageUndo } from "@/lib/commands";
import { useMail } from "@/stores/mail";
import { actionTargetThreadIds, useUi } from "@/stores/ui";
import { PickerShell, type PickerItem } from "./PickerShell";

export function MovePicker() {
  const [labels, setLabels] = useState<string[]>([]);
  const ids = actionTargetThreadIds();

  useEffect(() => {
    void backend.listLabels().then(setLabels);
  }, []);

  const items: PickerItem[] = labels.map((label) => ({
    label,
    run: async () => {
      if (ids.length === 0) return;
      const mail = useMail.getState();
      for (const id of ids) await mail.moveLabel(id, label);
      mail.clearSelection();
      // moveLabel toggles, so applying it again is its own inverse
      pushTriageUndo(
        ids.length > 1 ? `Label "${label}" (${ids.length})` : `Label "${label}"`,
        async () => {
          for (const id of ids) await useMail.getState().moveLabel(id, label);
        }
      );
      useUi.getState().showToast(
        ids.length > 1
          ? `Toggled label "${label}" on ${ids.length} conversations`
          : `Toggled label "${label}"`
      );
    },
  }));

  return <PickerShell title="Move to folder / label" items={items} filterable />;
}
