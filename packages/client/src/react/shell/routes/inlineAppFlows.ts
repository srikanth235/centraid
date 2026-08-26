import { deleteApp, updateAppMeta } from "../../../gateway-client.js";
import type { ShellActions } from "../actions.js";
import { openPrompt } from "../prompt.js";

// The two app-management flows behind an inline app's settings panel.
//
// Extracted from `InlineAppRoute` to keep that host under the file cap: they
// are dialogue and gateway calls, not frame integration, and nothing in them
// touches the mounted app.
//
// Both report on the ONE status line — `showToast` is that line's imperative
// alias (`App.tsx` binds it to `postStatus`), so there is no toast here despite
// the name. New callers should reach for the status line directly.

export interface InlineAppFlowDeps {
  app: AppMetaResolvedType;
  confirm: ShellActions["confirm"];
  say: ShellActions["showToast"];
  onDeleted: () => void;
}

const reason = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export async function renameInlineApp({
  app,
  say,
}: Pick<InlineAppFlowDeps, "app" | "say">): Promise<void> {
  const next = await openPrompt({
    title: "Rename app",
    initial: app.name,
    placeholder: "App name",
    confirmLabel: "Rename",
  });
  if (!next) return;
  try {
    await updateAppMeta({ id: app.id, name: next });
    say(`Renamed to "${next}"`);
  } catch (error) {
    say(`Could not rename: ${reason(error)}`);
  }
}

/** Code-store apps only: the panel gives a bundled app no danger zone at all
 *  (#708 — it reinstalls at every vault mount, so there is nothing an
 *  uninstall could durably mean). */
export async function deleteInlineApp({
  app,
  confirm,
  say,
  onDeleted,
}: InlineAppFlowDeps): Promise<void> {
  const ok = await confirm({
    confirmLabel: "Delete",
    danger: true,
    title: "Delete app?",
    message: `Delete "${app.name}"? This removes it from the gateway and wipes its local app files.`,
  });
  if (!ok) return;
  try {
    await deleteApp({ id: app.id });
    say(`Deleted "${app.name}"`);
    onDeleted();
  } catch (error) {
    say(`Could not delete: ${reason(error)}`);
  }
}
