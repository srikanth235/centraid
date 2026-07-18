/**
 * Log a touch (message, call, met up, note); stamps last-contacted so they drop off Reconnect. Runs through people.log_interaction — consent-checked and receipted, risk low.
 */
export default async ({ body, ctx }: HandlerArgs) => {
  try {
    const outcome = await ctx.vault.invoke({
      command: 'people.log_interaction',
      input: (body ?? {}) as Record<string, unknown>,
      purpose: 'dpv:ServiceProvision',
    });
    return { status: 200, body: outcome };
  } catch (err) {
    const e = err as { code?: string; message?: string };
    return { status: 200, body: { status: 'denied', reason: e.message, code: e.code } };
  }
};
