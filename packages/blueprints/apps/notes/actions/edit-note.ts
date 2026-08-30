import { actionInput, runVaultAction } from "../../_shared/action-kit.ts";
import { normalizeCommonMark } from "../commonmark.ts";

/**
 * Partial update: only the fields sent change, and a body edit re-points the
 * note at another content item rather than mutating canonical bytes. Pinning
 * is a field, not its own command — a flag with no lifecycle.
 */
export default async function editNote({ body, ctx }: HandlerArgs) {
  const input = actionInput(body);
  return runVaultAction(ctx, {
    command: "knowledge.edit_note",
    input: {
      note_id: String(input.note_id ?? ""),
      ...(input.title == null ? {} : { title: String(input.title) }),
      ...(input.body_text == null
        ? {}
        : { body_text: normalizeCommonMark(input.body_text) }),
      ...(input.format == null ? {} : { format: String(input.format) }),
      ...(input.pinned == null ? {} : { pinned: Number(input.pinned) }),
    },
  });
}
