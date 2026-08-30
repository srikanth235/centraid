import { actionInput, runVaultAction } from "../../_shared/action-kit.ts";

export default async function renameList({ body, ctx }: HandlerArgs) {
  return runVaultAction(ctx, {
    command: "people.rename_list",
    input: actionInput(body),
  });
}
