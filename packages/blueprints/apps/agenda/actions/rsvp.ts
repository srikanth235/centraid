/**
 * Record an RSVP — the first boundary's one real state machine (RFC 5545
 * PARTSTAT). The vault refuses responses from parties never invited and
 * responses to cancelled events; those arrive here as `failed` outcomes.
 */
export default async ({ body, ctx }: HandlerArgs): Promise<ActionResult> => {
  const input = (body ?? {}) as Record<string, unknown>;
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
    const e = err as { code?: string; message?: string };
    return { status: 200, body: { status: 'denied', reason: e.message, code: e.code } };
  }
};
