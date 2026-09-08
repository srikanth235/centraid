import { actionInput, runVaultAction } from "../../_shared/action-kit.ts";

export default async function completeTask({ body, ctx }: HandlerArgs) {
  return runVaultAction(ctx, {
    command: "people.complete_task",
    input: actionInput(body),
  });
}
