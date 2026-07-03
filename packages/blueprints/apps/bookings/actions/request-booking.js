/**
 * Request a slot through schedule.request_booking. The command is risk high
 * for an app — it cannot seize the owner's calendar for a client — so when
 * this app invokes it the request PARKS for the owner's confirmation; the
 * parked outcome passes through verbatim so the UI narrates the wait. On
 * approval a tentative hold lands, which confirm-booking then promotes.
 *
 * @type {import('@centraid/openclaw-plugin').ActionHandler}
 */
export default async ({ body, ctx }) => {
  const input = body ?? {};
  try {
    const outcome = await ctx.vault.invoke({
      command: 'schedule.request_booking',
      input: {
        calendar_id: String(input.calendar_id ?? ''),
        summary: String(input.summary ?? ''),
        dtstart: String(input.dtstart ?? ''),
        dtend: String(input.dtend ?? ''),
        requester_party_id: String(input.requester_party_id ?? ''),
        ...(input.description != null ? { description: String(input.description) } : {}),
      },
      purpose: 'dpv:ServiceProvision',
    });
    return { status: 200, body: outcome };
  } catch (err) {
    return { status: 200, body: { status: 'denied', reason: err.message, code: err.code } };
  }
};
