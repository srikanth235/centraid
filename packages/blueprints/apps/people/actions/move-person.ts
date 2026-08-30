import { actionInput, runVaultAction } from "../../_shared/action-kit.ts";

/** Omit the list to un-list. */
export default async function movePerson({ body, ctx }: HandlerArgs) {
  return runVaultAction(ctx, {
    command: "people.move_person",
    input: actionInput(body),
  });
}
