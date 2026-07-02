/**
 * Summarize a vital's trend through the vault's typed command. On success
 * `outcome.output` carries `{ count, min, max, avg, content_id }` — the
 * summary itself is persisted as owned content the app never holds. A trend
 * over zero readings is refused by the vault as a `failed` precondition.
 *
 * @type {import('@centraid/openclaw-plugin').ActionHandler}
 */
export default async ({ body, ctx }) => {
  const input = body ?? {};
  try {
    const outcome = await ctx.vault.invoke({
      command: 'health.summarize_trends',
      input: {
        vital_type: String(input.vital_type ?? ''),
        days: Number(input.days),
      },
      purpose: 'dpv:HealthMonitoring',
    });
    return { status: 200, body: outcome };
  } catch (err) {
    return { status: 200, body: { status: 'denied', reason: err.message, code: err.code } };
  }
};
