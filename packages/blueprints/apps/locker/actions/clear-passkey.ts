import { actionInput, runVaultAction } from "../../_shared/action-kit.ts";

export default async function clearPasskey({ body, ctx }: HandlerArgs) {
  const input = actionInput(body);
  return runVaultAction(ctx, {
    command: "locker.clear_passkey",
    input: { item_id: String(input.item_id ?? "") },
  });
}
