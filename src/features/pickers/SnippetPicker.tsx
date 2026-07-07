import { useSettings } from "@/stores/settings";
import { escapeHtml, useUi } from "@/stores/ui";
import { PickerShell, type PickerItem } from "./PickerShell";

/** Plain snippet text → simple paragraph HTML for the editor. */
function paragraphsToHtml(text: string): string {
  return text
    .split(/\n{2,}/)
    .map((p) => `<p>${escapeHtml(p).replace(/\n/g, "<br>") || "<br>"}</p>`)
    .join("");
}

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
            // The editor is uncontrolled after seeding, so writing to
            // compose.body would never reach it — insert via the live
            // instance, the same way Drive chips do.
            window.dispatchEvent(
              new CustomEvent("fission:insert-html", {
                detail: { html: paragraphsToHtml(sn.body) }
              })
            );
          },
        }));

  return <PickerShell title="Insert snippet" items={items} filterable />;
}
