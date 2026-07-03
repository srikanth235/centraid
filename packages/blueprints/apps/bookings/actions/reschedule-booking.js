/**
 * Move a booking: same identity, new times, SEQUENCE bumped by the vault
 * command. Medium-risk, so it parks for the owner; the outcome passes
 * through for the UI to narrate.
 *
 * @type {import('@centraid/openclaw-plugin').ActionHandler}
 */
export default async ({ body, ctx }) => {
  const input = body ?? {};
  try {
    const outcome = await ctx.vault.invoke({
      command: 'schedule.reschedule_event',
      input: {
        event_id: String(input.event_id ?? ''),
        dtstart: String(input.dtstart ?? ''),
        dtend: String(input.dtend ?? ''),
      },
      purpose: 'dpv:ServiceProvision',
    });
    return { status: 200, body: outcome };
  } catch (err) {
    return { status: 200, body: { status: 'denied', reason: err.message, code: err.code } };
  }
};
