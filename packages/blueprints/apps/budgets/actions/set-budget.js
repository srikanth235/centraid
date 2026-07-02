/**
 * Set or update a spending cap through the vault's typed command. A cap is
 * the only stored artefact — progress against it stays a projection, never
 * a row. Outcome passed through for the UI to narrate.
 *
 * @type {import('@centraid/openclaw-plugin').ActionHandler}
 */
export default async ({ body, ctx }) => {
  const input = body ?? {};
  try {
    const outcome = await ctx.vault.invoke({
      command: 'finance.set_budget',
      input: {
        category_concept_id: String(input.category_concept_id ?? ''),
        period: String(input.period ?? ''),
        limit_minor: Number(input.limit_minor ?? 0),
        currency: String(input.currency ?? ''),
        starts_on: String(input.starts_on ?? ''),
      },
      purpose: 'dpv:Billing',
    });
    return { status: 200, body: outcome };
  } catch (err) {
    return { status: 200, body: { status: 'denied', reason: err.message, code: err.code } };
  }
};
