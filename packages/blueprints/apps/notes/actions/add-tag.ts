import { actionInput, runVaultAction } from "../../_shared/action-kit.ts";

/**
 * Tag a note through core.tag_item — the Tags concept scheme shared across
 * apps. Idempotent: a label already on the note returns the existing edge.
 */
export default async function addTag({ body, ctx }: HandlerArgs) {
  const input = actionInput(body);
  return runVaultAction(ctx, {
    command: "core.tag_item",
    input: {
      subject_type: "knowledge.note",
      subject_id: String(input.note_id ?? ""),
      label: String(input.label ?? ""),
    },
  });
}
