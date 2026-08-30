import { actionInput, runVaultAction } from "../../_shared/action-kit.ts";

export default async function organizeTask({ body, ctx }: HandlerArgs) {
  return runVaultAction(ctx, {
    command: "schedule.organize_task",
    input: actionInput(body),
  });
}
