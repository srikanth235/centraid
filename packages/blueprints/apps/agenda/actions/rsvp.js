/**
 * Record an RSVP — the first boundary's one real state machine (RFC 5545
 * PARTSTAT). The vault refuses responses from parties never invited and
 * responses to cancelled events; those arrive here as `failed` outcomes.
 *
 * @type {import('@centraid/app-engine').ActionHandler}
 */
export default async ({ body, ctx }) => {
  const input = body ?? {};
  try {
    const outcome = await ctx.vault.invoke({
      command: 'schedule.respond_rsvp',
      input: {
        event_id: String(input.event_id ?? ''),
        party_id: String(input.party_id ?? ''),
        partstat: String(input.partstat ?? ''),
      },
      purpose: 'dpv:ServiceProvision',
    });
    return { status: 200, body: outcome };
  } catch (err) {
    return { status: 200, body: { status: 'denied', reason: err.message, code: err.code } };
  }
};
