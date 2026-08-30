import { actionInput, runVaultAction } from "../../_shared/action-kit.ts";

export default async function saveProject({ body, ctx }: HandlerArgs) {
  return runVaultAction(ctx, {
    command: "schedule.save_project",
    input: actionInput(body),
  });
}
