import { actionInput, runVaultAction } from "../../_shared/action-kit.ts";

export default async function restoreNoteVersion({ body, ctx }: HandlerArgs) {
  const input = actionInput(body);
  return runVaultAction(ctx, {
    command: "knowledge.restore_note_version",
    input: {
      note_id: String(input.note_id ?? ""),
      content_id: String(input.content_id ?? ""),
    },
  });
}
