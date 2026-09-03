import { deleteApp, updateAppMeta } from "../../../gateway-client.js";
import type { ShellActions } from "../actions.js";
import { openPrompt } from "../prompt.js";

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
