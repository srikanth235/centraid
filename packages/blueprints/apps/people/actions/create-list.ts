import { actionInput, runVaultAction } from "../../_shared/action-kit.ts";

export default async function createList({ body, ctx }: HandlerArgs) {
  return runVaultAction(ctx, {
    command: "people.create_list",
    input: actionInput(body),
  });
}
