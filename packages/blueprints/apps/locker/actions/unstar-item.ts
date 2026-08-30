import { actionInput, runVaultAction } from "../../_shared/action-kit.ts";

export default async function unstarItem({ body, ctx }: HandlerArgs) {
  const input = actionInput(body);
  return runVaultAction(ctx, {
    command: "locker.unstar_item",
    input: { item_id: String(input.item_id ?? "") },
  });
}
