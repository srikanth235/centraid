/**
 * Add a note about a person, kept as a searchable annotation on their party. Runs through people.add_note — consent-checked and receipted, risk low.
 *
 * @type {import('@centraid/openclaw-plugin').ActionHandler}
 */
export default async ({ body, ctx }) => {
  try {
    const outcome = await ctx.vault.invoke({
      command: 'people.add_note',
      input: body ?? {},
      purpose: 'dpv:ServiceProvision',
    });
    return { status: 200, body: outcome };
  } catch (err) {
    return { status: 200, body: { status: 'denied', reason: err.message, code: err.code } };
  }
};
