import { actionInput, runVaultAction } from "../../_shared/action-kit.ts";

/** A snapshot applies once. */
export default async function undoPerson({ body, ctx }: HandlerArgs) {
  return runVaultAction(ctx, {
    command: "people.undo_person",
    input: actionInput(body),
  });
}
