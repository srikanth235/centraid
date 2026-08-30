import { actionInput, runVaultAction } from "../../_shared/action-kit.ts";

/**
 * core.detach drops the edge only: the canonical content item is deduped and
 * may back other attachments.
 */
export default async function detachHandler({
  body,
  ctx,
}: HandlerArgs): Promise<ActionResult> {
  const input = actionInput(body);
  return runVaultAction(ctx, {
    command: "core.detach",
    input: { attachment_id: String(input.attachment_id ?? "") },
  });
}
