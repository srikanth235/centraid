/**
 * Decline a pending request or cancel a confirmed booking. The vault command
 * flips the event to cancelled and bumps SEQUENCE; it is medium-risk and
 * apps run at a low ceiling, so the outcome comes back PARKED — an ask in
 * flight for the owner, not an error.
 *
 * @type {import('@centraid/openclaw-plugin').ActionHandler}
 */
export default async ({ body, ctx }) => {
  const input = body ?? {};
  try {
    const outcome = await ctx.vault.invoke({
      command: 'schedule.cancel_event',
      input: {
        event_id: String(input.event_id ?? ''),
      },
      purpose: 'dpv:ServiceProvision',
    });
    return { status: 200, body: outcome };
  } catch (err) {
    return { status: 200, body: { status: 'denied', reason: err.message, code: err.code } };
  }
};
