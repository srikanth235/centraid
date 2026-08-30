import { actionInput, runVaultAction } from "../../_shared/action-kit.ts";

/** Kept as a searchable annotation on the party. */
export default async function addNote({ body, ctx }: HandlerArgs) {
  return runVaultAction(ctx, {
    command: "people.add_note",
    input: actionInput(body),
  });
}
