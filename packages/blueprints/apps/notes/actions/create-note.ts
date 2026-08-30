import { actionInput, runVaultAction } from "../../_shared/action-kit.ts";
import { normalizeCommonMark } from "../commonmark.ts";

/**
 * The body becomes a canonical core.content_item (sha256-deduped data: URI);
 * the note row only references it. Outcome passes through verbatim so the UI
 * can narrate the consent decision.
 */
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
