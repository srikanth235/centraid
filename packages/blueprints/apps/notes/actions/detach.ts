import { actionInput, runVaultAction } from "../../_shared/action-kit.ts";

export default async function detachHandler({ body, ctx }: HandlerArgs) {
  const input = actionInput(body);
  return runVaultAction(ctx, {
    command: "core.detach",
    input: { attachment_id: String(input.attachment_id ?? "") },
  });
}
