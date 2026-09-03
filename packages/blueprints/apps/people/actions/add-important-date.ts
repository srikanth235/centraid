import { actionInput, runVaultAction } from "../../_shared/action-kit.ts";

export default async function addImportantDate({ body, ctx }: HandlerArgs) {
  return runVaultAction(ctx, {
    command: "people.add_important_date",
    input: actionInput(body),
  });
}
