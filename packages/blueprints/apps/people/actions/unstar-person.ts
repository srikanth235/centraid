import { actionInput, runVaultAction } from "../../_shared/action-kit.ts";

export default async function unstarPerson({ body, ctx }: HandlerArgs) {
  return runVaultAction(ctx, {
    command: "people.unstar_person",
    input: actionInput(body),
  });
}
