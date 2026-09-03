import { actionInput, runVaultAction } from "../../_shared/action-kit.ts";
import { normalizeCommonMark } from "../commonmark.ts";

export default async function createNote({ body, ctx }: HandlerArgs) {
  const input = actionInput(body);
  return runVaultAction(ctx, {
    command: "knowledge.create_note",
    input: {
      title: String(input.title ?? ""),
      body_text: normalizeCommonMark(input.body_text),
      format: input.format == null ? "markdown" : String(input.format),
      ...(input.notebook_id == null
        ? {}
        : { notebook_id: String(input.notebook_id) }),
    },
  });
}
