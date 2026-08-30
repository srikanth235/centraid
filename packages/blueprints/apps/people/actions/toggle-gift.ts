import { actionInput, runVaultAction } from "../../_shared/action-kit.ts";

export default async function toggleGift({ body, ctx }: HandlerArgs) {
  return runVaultAction(ctx, {
    command: "people.toggle_gift",
    input: actionInput(body),
  });
}
