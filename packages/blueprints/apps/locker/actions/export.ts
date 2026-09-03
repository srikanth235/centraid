import { actionInput, runVaultAction } from "../../_shared/action-kit.ts";

export default async function exportLocker({ body, ctx }: HandlerArgs) {
  const input = actionInput(body);
  return runVaultAction(ctx, {
    command: "locker.export",
    input: {
      confirm: input.confirm === true,
      ...(input.include_trashed === true ? { include_trashed: true } : {}),
      ...(input.include_history === true ? { include_history: true } : {}),
    },
  });
}
