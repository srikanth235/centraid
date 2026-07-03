/**
 * Declare a weekly availability window through schedule.set_availability.
 * The weekday_mask is a 7-bit Monday-first set the app builds from day
 * toggles. Risk low — describing when you work commits nothing.
 *
 * @type {import('@centraid/openclaw-plugin').ActionHandler}
 */
export default async ({ body, ctx }) => {
  const input = body ?? {};
  try {
    const outcome = await ctx.vault.invoke({
      command: 'schedule.set_availability',
      input: {
        weekday_mask: Number(input.weekday_mask ?? 0),
        window_start: String(input.window_start ?? ''),
        window_end: String(input.window_end ?? ''),
        tz: String(input.tz ?? 'UTC'),
        ...(input.kind != null ? { kind: String(input.kind) } : {}),
      },
      purpose: 'dpv:ServiceProvision',
    });
    return { status: 200, body: outcome };
  } catch (err) {
    return { status: 200, body: { status: 'denied', reason: err.message, code: err.code } };
  }
};
