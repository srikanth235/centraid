import { actionInput, runVaultAction } from "../../_shared/action-kit.ts";

export default async function untag({ body, ctx }: HandlerArgs) {
  const input = actionInput(body);
  return runVaultAction(ctx, {
    command: "core.untag_item",
    input: { tag_id: String(input.tag_id ?? "") },
  });
}
