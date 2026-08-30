import { actionInput, runVaultAction } from "../../_shared/action-kit.ts";

/** Owner-level, not person-scoped. */
export default async function addJournalEntry({ body, ctx }: HandlerArgs) {
  return runVaultAction(ctx, {
    command: "people.add_journal_entry",
    input: actionInput(body),
  });
}
