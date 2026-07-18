/**
 * tally.add_group_member — see app.json for the contract. Consent denials and precondition
 * refusals come back as first-class outcomes the app narrates.
 */
const KEYS = ['group_id', 'party_id'];
export default async ({ body, ctx }: HandlerArgs) => {
  const input = (body ?? {}) as Record<string, unknown>;
  const cmdInput: Record<string, unknown> = {};
  for (const k of KEYS) if (input[k] !== undefined && input[k] !== null) cmdInput[k] = input[k];
  try {
    const outcome = await ctx.vault.invoke({
      command: 'tally.add_group_member',
      input: cmdInput,
      purpose: 'dpv:ServiceProvision',
    });
    return { status: 200, body: outcome };
  } catch (err) {
    const e = err as { code?: string; message?: string };
    return { status: 200, body: { status: 'denied', reason: e.message, code: e.code } };
  }
};
