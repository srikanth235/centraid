import { actionInput, runVaultAction } from "../../_shared/action-kit.ts";

export default async function addPerson({ body, ctx }: HandlerArgs) {
  return runVaultAction(ctx, {
    command: "people.add_person",
    input: actionInput(body),
  });
}
