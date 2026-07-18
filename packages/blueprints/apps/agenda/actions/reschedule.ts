/**
 * Move an event: same identity, new times, SEQUENCE bumped by the vault
 * command. Outcome passed through for the UI to narrate.
 */
export default async ({ body, ctx }: HandlerArgs): Promise<ActionResult> => {
  const input = (body ?? {}) as Record<string, unknown>;
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
    const e = err as { code?: string; message?: string };
    return { status: 200, body: { status: 'denied', reason: e.message, code: e.code } };
  }
};
