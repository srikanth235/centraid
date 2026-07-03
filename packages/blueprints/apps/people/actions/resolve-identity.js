/**
 * Bind a raw handle (email, tel, or handle) to a party through the vault's
 * typed command. Resolution is retroactive: the command also backfills any
 * thread participants and messages that carried the raw handle without a
 * party reference. Refuses if the handle is already claimed by a different
 * party — one identity per handle is the social domain's core invariant.
 *
 * @type {import('@centraid/openclaw-plugin').ActionHandler}
 */
export default async ({ body, ctx }) => {
  const input = body ?? {};
  try {
    const outcome = await ctx.vault.invoke({
      command: 'social.resolve_identity',
      input: {
        party_id: String(input.party_id ?? ''),
        scheme: String(input.scheme ?? ''),
        value: String(input.value ?? ''),
        ...(input.label != null ? { label: String(input.label) } : {}),
      },
      purpose: 'dpv:ServiceProvision',
    });
    return { status: 200, body: outcome };
  } catch (err) {
    return { status: 200, body: { status: 'denied', reason: err.message, code: err.code } };
  }
};
