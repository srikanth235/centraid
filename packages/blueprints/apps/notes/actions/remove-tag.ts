import { actionInput, runVaultAction } from "../../_shared/action-kit.ts";

/** Only the edge goes: the shared concept and its scheme survive. */
export default async function removeTag({ body, ctx }: HandlerArgs) {
  const input = actionInput(body);
  return runVaultAction(ctx, {
    command: "core.untag_item",
    input: { tag_id: String(input.tag_id ?? "") },
  });
}
