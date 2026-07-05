/**
 * tally.settle_up — see app.json for the contract. Consent denials and precondition
 * refusals come back as first-class outcomes the app narrates.
 *
 * @type {import('@centraid/openclaw-plugin').ActionHandler}
 */
const KEYS = ['from_party', 'to_party', 'amount_minor', 'group_id', 'paid_on'];
export default async ({ body, ctx }) => {
  const input = body ?? {};
  const cmdInput = {};
  for (const k of KEYS) if (input[k] !== undefined && input[k] !== null) cmdInput[k] = input[k];
  try {
    const outcome = await ctx.vault.invoke({
      command: 'tally.settle_up',
      input: cmdInput,
      purpose: 'dpv:ServiceProvision',
    });
    return { status: 200, body: outcome };
  } catch (err) {
    return { status: 200, body: { status: 'denied', reason: err.message, code: err.code } };
  }
};
