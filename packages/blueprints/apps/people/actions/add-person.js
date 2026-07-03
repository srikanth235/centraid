/**
 * Mint a brand-new party through core.add_party, binding any email, tel, or
 * handle identifiers provided in the same stroke. Risk low. The vault
 * refuses (status 'failed') when an identifier is already claimed by a
 * different party — one identity per handle is the core invariant — so the
 * outcome is passed through verbatim for the UI to narrate.
 *
 * @type {import('@centraid/openclaw-plugin').ActionHandler}
 */
export default async ({ body, ctx }) => {
  const input = body ?? {};
  try {
    const identifiers = [];
    if (input.email) identifiers.push({ scheme: 'email', value: String(input.email) });
    if (input.tel) identifiers.push({ scheme: 'tel', value: String(input.tel) });
    if (input.handle) identifiers.push({ scheme: 'handle', value: String(input.handle) });
    const outcome = await ctx.vault.invoke({
      command: 'core.add_party',
      input: {
        display_name: String(input.display_name ?? ''),
        ...(identifiers.length > 0 ? { identifiers } : {}),
      },
      purpose: 'dpv:ServiceProvision',
    });
    return { status: 200, body: outcome };
  } catch (err) {
    return { status: 200, body: { status: 'denied', reason: err.message, code: err.code } };
  }
};
