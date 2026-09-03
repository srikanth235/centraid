import { actionInput, runVaultAction } from "../../_shared/action-kit.ts";

export default async function addDebt({ body, ctx }: HandlerArgs) {
  return runVaultAction(ctx, {
    command: "people.add_debt",
    input: actionInput(body),
  });
}
