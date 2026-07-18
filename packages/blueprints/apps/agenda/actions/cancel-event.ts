/**
 * Ask to cancel an event: status flips to cancelled and SEQUENCE bumps, but
 * the command is medium-risk and apps run at a low risk ceiling, so the
 * vault PARKS it for the owner's confirmation. 'parked' comes back through
 * here as a first-class outcome for the UI to narrate — an ask in flight,
 * not an error.
 */
export default async ({ body, ctx }: HandlerArgs): Promise<ActionResult> => {
  const input = (body ?? {}) as Record<string, unknown>;
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
    const e = err as { code?: string; message?: string };
    return { status: 200, body: { status: 'denied', reason: e.message, code: e.code } };
  }
};
