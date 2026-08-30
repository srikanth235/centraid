import { actionInput, runVaultAction } from "../../_shared/action-kit.ts";

/** Stamps last-contacted, which clears them from Reconnect. */
export default async function logInteraction({ body, ctx }: HandlerArgs) {
  return runVaultAction(ctx, {
    command: "people.log_interaction",
    input: actionInput(body),
  });
}
