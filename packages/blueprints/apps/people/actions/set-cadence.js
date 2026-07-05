/**
 * Set how often you want to reach out to a person. Runs through people.set_cadence — consent-checked and receipted, risk low.
 *
 * @type {import('@centraid/openclaw-plugin').ActionHandler}
 */
export default async ({ body, ctx }) => {
  try {
    const outcome = await ctx.vault.invoke({
      command: 'people.set_cadence',
      input: body ?? {},
      purpose: 'dpv:ServiceProvision',
    });
    return { status: 200, body: outcome };
  } catch (err) {
    return { status: 200, body: { status: 'denied', reason: err.message, code: err.code } };
  }
};
