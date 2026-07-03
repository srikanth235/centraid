/**
 * Save a running note on a lead through social.update_card. The note lives on
 * the party's contact card (enrichment, not identity), so it follows the
 * person across every app. Risk low.
 *
 * @type {import('@centraid/openclaw-plugin').ActionHandler}
 */
export default async ({ body, ctx }) => {
  const input = body ?? {};
  try {
    const outcome = await ctx.vault.invoke({
      command: 'social.update_card',
      input: {
        party_id: String(input.party_id ?? ''),
        note: String(input.note ?? ''),
      },
      purpose: 'dpv:Billing',
    });
    return { status: 200, body: outcome };
  } catch (err) {
    return { status: 200, body: { status: 'denied', reason: err.message, code: err.code } };
  }
};
