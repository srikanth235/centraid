import { actionInput, runVaultAction } from "../../_shared/action-kit.ts";

/**
 * Placements, annotations and attachment edges go with the note; the deduped
 * body's bytes release only when nothing else shares them (body_released).
 */
export default async function deleteNote({ body, ctx }: HandlerArgs) {
  const input = actionInput(body);
  return runVaultAction(ctx, {
    command: "knowledge.delete_note",
    input: {
      note_id: String(input.note_id ?? ""),
    },
  });
}
