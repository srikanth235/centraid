import { actionInput, runVaultAction } from "../../_shared/action-kit.ts";

/** Un-trashes in place; links survive. */
export default async function restoreNote({ body, ctx }: HandlerArgs) {
  const input = actionInput(body);
  return runVaultAction(ctx, {
    command: "knowledge.restore_note",
    input: { note_id: String(input.note_id ?? "") },
  });
}
