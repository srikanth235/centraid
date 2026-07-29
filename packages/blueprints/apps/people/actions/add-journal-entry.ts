/**
 * Add an owner-level journal entry with a mood and a line about your day. Runs through people.add_journal_entry — consent-checked and receipted, risk low.
 */
export default async function addJournalEntry({ body, ctx }: HandlerArgs) {
  try {
    const outcome = await ctx.vault.invoke({
      command: "people.add_journal_entry",
      input: (body ?? {}) as Record<string, unknown>,
      purpose: "dpv:ServiceProvision",
    });
    return { status: 200, body: outcome };
  } catch (error) {
    const e = error as { code?: string; message?: string };
    return {
      status: 200,
      body: { status: "denied", reason: e.message, code: e.code },
    };
  }
}
