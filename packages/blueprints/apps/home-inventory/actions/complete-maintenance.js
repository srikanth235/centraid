/**
 * Stamp a maintenance plan done through the vault's typed command —
 * last_done_on moves to done_on and the projected next-due date rolls
 * forward from the plan's rrule. Re-stamping is legitimate: repeating
 * chores are done again and again.
 *
 * @type {import('@centraid/openclaw-plugin').ActionHandler}
 */
export default async ({ body, ctx }) => {
  const input = body ?? {};
  try {
    const outcome = await ctx.vault.invoke({
      command: 'home.complete_maintenance',
      input: {
        plan_id: String(input.plan_id ?? ''),
        done_on: String(input.done_on ?? ''),
      },
      purpose: 'dpv:ServiceProvision',
    });
    return { status: 200, body: outcome };
  } catch (err) {
    return { status: 200, body: { status: 'denied', reason: err.message, code: err.code } };
  }
};
