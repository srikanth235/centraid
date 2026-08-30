import { actionInput, runVaultAction } from "../../_shared/action-kit.ts";

/** Mints a canonical core.party plus its people_profile. */
export default async function addPerson({ body, ctx }: HandlerArgs) {
  return runVaultAction(ctx, {
    command: "people.add_person",
    input: actionInput(body),
  });
}
