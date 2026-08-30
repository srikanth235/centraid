import { actionInput, runVaultAction } from "../../_shared/action-kit.ts";

export default async function setCadence({ body, ctx }: HandlerArgs) {
  return runVaultAction(ctx, {
    command: "people.set_cadence",
    input: actionInput(body),
  });
}
