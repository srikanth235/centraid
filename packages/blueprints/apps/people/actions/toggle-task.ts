import { actionInput, runVaultAction } from "../../_shared/action-kit.ts";

export default async function toggleTask({ body, ctx }: HandlerArgs) {
  return runVaultAction(ctx, {
    command: "people.toggle_task",
    input: actionInput(body),
  });
}
