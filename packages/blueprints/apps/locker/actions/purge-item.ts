import { actionInput, runVaultAction } from "../../_shared/action-kit.ts";

export default async function purgeItem({ body, ctx }: HandlerArgs) {
  const input = actionInput(body);
  return runVaultAction(ctx, {
    command: "locker.purge_item",
    input: { item_id: String(input.item_id ?? "") },
  });
}
