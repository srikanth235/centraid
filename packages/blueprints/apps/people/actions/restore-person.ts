import { actionInput, runVaultAction } from "../../_shared/action-kit.ts";

export default async function restorePerson({ body, ctx }: HandlerArgs) {
  return runVaultAction(ctx, {
    command: "people.restore_person",
    input: actionInput(body),
  });
}
