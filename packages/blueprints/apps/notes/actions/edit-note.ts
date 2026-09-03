import { actionInput, runVaultAction } from "../../_shared/action-kit.ts";
import { normalizeCommonMark } from "../commonmark.ts";

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
