/**
 * tally.add_friend — see app.json for the contract. Consent denials and precondition
 * refusals come back as first-class outcomes the app narrates.
 *
 * @type {import('@centraid/app-engine').ActionHandler}
 */
const KEYS = ['name'];
export default async ({ body, ctx }) => {
  const input = body ?? {};
  const cmdInput = {};
  for (const k of KEYS) if (input[k] !== undefined && input[k] !== null) cmdInput[k] = input[k];
  try {
    const outcome = await ctx.vault.invoke({
      command: 'tally.add_friend',
      input: cmdInput,
      purpose: 'dpv:ServiceProvision',
    });
    return { status: 200, body: outcome };
  } catch (err) {
    return { status: 200, body: { status: 'denied', reason: err.message, code: err.code } };
  }
};
