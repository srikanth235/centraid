import { actionInput, runVaultAction } from "../../_shared/action-kit.ts";

export default async function reopenTask({ body, ctx }: HandlerArgs) {
  return runVaultAction(ctx, {
    command: "people.reopen_task",
    input: actionInput(body),
  });
}
