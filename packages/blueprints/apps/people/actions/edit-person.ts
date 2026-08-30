import { actionInput, runVaultAction } from "../../_shared/action-kit.ts";

export default async function editPerson({ body, ctx }: HandlerArgs) {
  return runVaultAction(ctx, {
    command: "people.edit_person",
    input: actionInput(body),
  });
}
