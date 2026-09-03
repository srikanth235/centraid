import { actionInput, runVaultAction } from "../../_shared/action-kit.ts";

export default async function addNote({ body, ctx }: HandlerArgs) {
  return runVaultAction(ctx, {
    command: "people.add_note",
    input: actionInput(body),
  });
}
