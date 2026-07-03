/**
 * Create a brand-new contact and enroll them as a lead in one flow. First
 * core.add_party mints the party, binding email/tel identifiers when
 * provided; if that does not execute, its outcome is returned as-is. Then
 * business.add_client puts the new party at the top of the pipeline. The
 * second outcome is returned with the new party_id so the UI can narrate;
 * if enrolling fails the person still exists and shows up as a candidate.
 * Risk low for both commands.
 *
 * @type {import('@centraid/openclaw-plugin').ActionHandler}
 */
export default async ({ body, ctx }) => {
  const input = body ?? {};
  try {
    const identifiers = [];
    if (input.email) identifiers.push({ scheme: 'email', value: String(input.email) });
    if (input.tel) identifiers.push({ scheme: 'tel', value: String(input.tel) });
    const created = await ctx.vault.invoke({
      command: 'core.add_party',
      input: {
        display_name: String(input.display_name ?? ''),
        ...(identifiers.length > 0 ? { identifiers } : {}),
      },
      purpose: 'dpv:Billing',
    });
    if (created.status !== 'executed') return { status: 200, body: created };
    const party_id = created.output.party_id;
    const enrolled = await ctx.vault.invoke({
      command: 'business.add_client',
      input: {
        party_id,
        currency: String(input.currency ?? ''),
        status: 'lead',
        ...(input.default_rate_minor != null
          ? { default_rate_minor: Number(input.default_rate_minor) }
          : {}),
      },
      purpose: 'dpv:Billing',
    });
    return { status: 200, body: { ...enrolled, party_id } };
  } catch (err) {
    return { status: 200, body: { status: 'denied', reason: err.message, code: err.code } };
  }
};
