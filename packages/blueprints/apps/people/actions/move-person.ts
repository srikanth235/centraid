import { actionInput, runVaultAction } from "../../_shared/action-kit.ts";

export default async function movePerson({ body, ctx }: HandlerArgs) {
  return runVaultAction(ctx, {
    command: "people.move_person",
    input: actionInput(body),
  });
}
