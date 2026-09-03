import { actionInput, runVaultAction } from "../../_shared/action-kit.ts";

export default async function moveNote({ body, ctx }: HandlerArgs) {
  const input = actionInput(body);
  return runVaultAction(ctx, {
    command: "knowledge.move_note",
    input: {
      note_id: String(input.note_id ?? ""),
      ...(input.notebook_id == null
        ? {}
        : { notebook_id: String(input.notebook_id) }),
    },
  });
}
