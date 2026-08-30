import { actionInput, runVaultAction } from "../../_shared/action-kit.ts";

/** Refuses a non-empty list. */
export default async function deleteList({ body, ctx }: HandlerArgs) {
  return runVaultAction(ctx, {
    command: "people.delete_list",
    input: actionInput(body),
  });
}
