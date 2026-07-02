import { useSettings } from "@/stores/settings";
import { useUi } from "@/stores/ui";
import { PickerShell, type PickerItem } from "./PickerShell";

/** Ctrl+; — insert a Knowledge Base snippet into the draft body. */
export function SnippetPicker() {
  const snippets = useSettings((s) => s.kb.snippets);

  const items: PickerItem[] =
    snippets.length === 0
      ? [
          {
            label: "No snippets yet — add them in Settings → Knowledge Base",
            run: () => useUi.getState().setScreen("settings"),
          },
        ]
      : snippets.map((sn) => ({
          label: sn.title,
          detail: `${sn.body.slice(0, 40)}…`,
          run: () => {
            useUi.setState((s) => ({
              compose: s.compose
                ? {
                    ...s.compose,
                    body: s.compose.body
                      ? `${s.compose.body.replace(/\s+$/, "")}\n\n${sn.body}`
                      : sn.body,
                  }
                : null,
            }));
          },
        }));

  return <PickerShell title="Insert snippet" items={items} filterable />;
}
