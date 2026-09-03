import { actionInput, runVaultAction } from "../../_shared/action-kit.ts";

export default async function trashPerson({ body, ctx }: HandlerArgs) {
  return runVaultAction(ctx, {
    command: "people.trash_person",
    input: actionInput(body),
  });
}
