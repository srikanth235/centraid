import { actionInput, runVaultAction } from "../../_shared/action-kit.ts";

/** One canonical flags-scheme star, shared vault-wide. */
export default async function starPerson({ body, ctx }: HandlerArgs) {
  return runVaultAction(ctx, {
    command: "people.star_person",
    input: actionInput(body),
  });
}
