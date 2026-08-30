import { actionInput, runVaultAction } from "../../_shared/action-kit.ts";

export default async function toggleReminder({ body, ctx }: HandlerArgs) {
  return runVaultAction(ctx, {
    command: "people.toggle_reminder",
    input: actionInput(body),
  });
}
