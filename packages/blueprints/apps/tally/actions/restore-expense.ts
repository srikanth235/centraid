/** Restore a soft-deleted expense, including its preserved splits. */
export default async ({ body, ctx }: HandlerArgs) => {
  const input = (body ?? {}) as { expense_id?: unknown };
  try {
    const outcome = await ctx.vault.invoke({
      command: 'tally.restore_expense',
      input: { expense_id: input.expense_id },
      purpose: 'dpv:ServiceProvision',
    });
    return { status: 200, body: outcome };
  } catch (err) {
    const e = err as { code?: string; message?: string };
    return { status: 200, body: { status: 'denied', reason: e.message, code: e.code } };
  }
};
