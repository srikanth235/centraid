import { actionInput, runVaultAction } from "../../_shared/action-kit.ts";

export default async function deleteList({ body, ctx }: HandlerArgs) {
  return runVaultAction(ctx, {
    command: "people.delete_list",
    input: actionInput(body),
  });
}
