import { actionInput, runVaultAction } from "../../_shared/action-kit.ts";

/**
 * An action over a command, not a query: only a command can unseal and write
 * the receipt a mass reveal owes — queries are read-only by directive, and a
 * replica read sees placeholders. Online-only: the payload is nothing but
 * secrets, and a secret never enters the durable offline queue.
 */

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
