export default async function editRecurringExpenseOccurrence({
  body,
  ctx,
}: HandlerArgs): Promise<ActionResult> {
  try {
    const outcome = await ctx.vault.invoke({
      command: "tally.edit_recurring_expense_occurrence",
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
