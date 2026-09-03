import { actionInput, runVaultAction } from "../../_shared/action-kit.ts";

export default async function addJournalEntry({ body, ctx }: HandlerArgs) {
  return runVaultAction(ctx, {
    command: "people.add_journal_entry",
    input: actionInput(body),
  });
}
