import { actionInput, runVaultAction } from "../../_shared/action-kit.ts";

export default async function addRelationship({ body, ctx }: HandlerArgs) {
  return runVaultAction(ctx, {
    command: "people.add_relationship",
    input: actionInput(body),
  });
}
