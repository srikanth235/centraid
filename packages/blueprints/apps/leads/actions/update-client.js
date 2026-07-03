/**
 * Move a lead through the pipeline (or revise its rate) through
 * business.update_client. Status is the pipeline: lead → active → past.
 * Risk low.
 *
 * @type {import('@centraid/openclaw-plugin').ActionHandler}
 */
export default async ({ body, ctx }) => {
  const input = body ?? {};
  try {
    const outcome = await ctx.vault.invoke({
      command: 'business.update_client',
      input: {
        client_id: String(input.client_id ?? ''),
        ...(input.status != null ? { status: String(input.status) } : {}),
        ...(input.default_rate_minor != null
          ? { default_rate_minor: Number(input.default_rate_minor) }
          : {}),
      },
      purpose: 'dpv:Billing',
    });
    return { status: 200, body: outcome };
  } catch (err) {
    return { status: 200, body: { status: 'denied', reason: err.message, code: err.code } };
  }
};
