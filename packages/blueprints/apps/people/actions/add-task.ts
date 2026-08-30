import { actionInput, runVaultAction } from "../../_shared/action-kit.ts";

export default async function addTask({ body, ctx }: HandlerArgs) {
  return runVaultAction(ctx, {
    command: "people.add_task",
    input: actionInput(body),
  });
}
