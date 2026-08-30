import { actionInput, runVaultAction } from "../../_shared/action-kit.ts";

export default async function addGift({ body, ctx }: HandlerArgs) {
  return runVaultAction(ctx, {
    command: "people.add_gift",
    input: actionInput(body),
  });
}
