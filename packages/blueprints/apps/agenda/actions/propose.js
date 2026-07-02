/**
 * Propose an event through the vault's typed command. The outcome is passed
 * through verbatim — `executed`, `parked` (awaiting owner confirmation),
 * `denied`, or `failed` (a precondition such as the busy-conflict check) —
 * so the UI can narrate what the consent plane decided.
 *
 * @type {import('@centraid/openclaw-plugin').ActionHandler}
 */
export default async ({ body, ctx }) => {
  const input = body ?? {};
  try {
    const outcome = await ctx.vault.invoke({
      command: 'schedule.propose_event',
      input: {
        summary: String(input.summary ?? ''),
        dtstart: String(input.dtstart ?? ''),
        dtend: String(input.dtend ?? ''),
        calendar_id: String(input.calendar_id ?? ''),
        ...(input.description ? { description: String(input.description) } : {}),
      },
      purpose: 'dpv:ServiceProvision',
    });
    return { status: 200, body: outcome };
  } catch (err) {
    return { status: 200, body: { status: 'denied', reason: err.message, code: err.code } };
  }
};
