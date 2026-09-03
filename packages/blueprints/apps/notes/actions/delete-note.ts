import { actionInput, runVaultAction } from "../../_shared/action-kit.ts";

export default async function deleteNote({ body, ctx }: HandlerArgs) {
  const input = actionInput(body);
  return runVaultAction(ctx, {
    command: "knowledge.delete_note",
    input: {
      note_id: String(input.note_id ?? ""),
    },
  });
}
