import { actionInput, runVaultAction } from "../../_shared/action-kit.ts";

/** The edge goes; the deduped content item stays — it may back other
 *  attachments. */
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
