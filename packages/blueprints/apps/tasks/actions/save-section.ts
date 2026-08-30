import { actionInput, runVaultAction } from "../../_shared/action-kit.ts";

export default async function saveSection({ body, ctx }: HandlerArgs) {
  return runVaultAction(ctx, {
    command: "schedule.save_section",
    input: actionInput(body),
  });
}
