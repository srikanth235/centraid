import { actionInput, runVaultAction } from "../../_shared/action-kit.ts";

export default async function starPerson({ body, ctx }: HandlerArgs) {
  return runVaultAction(ctx, {
    command: "people.star_person",
    input: actionInput(body),
  });
}
