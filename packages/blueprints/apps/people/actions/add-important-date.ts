import { actionInput, runVaultAction } from "../../_shared/action-kit.ts";

/** A birthday auto-creates its reminder. */
export default async function addImportantDate({ body, ctx }: HandlerArgs) {
  return runVaultAction(ctx, {
    command: "people.add_important_date",
    input: actionInput(body),
  });
}
