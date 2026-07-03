/**
 * Record warranty coverage on an item through the vault's typed command. An
 * item can accumulate several warranties over time — the vault only insists
 * ends_on is on or after starts_on; "active" stays a projection concern.
 *
 * @type {import('@centraid/openclaw-plugin').ActionHandler}
 */
export default async ({ body, ctx }) => {
  const input = body ?? {};
  try {
    const outcome = await ctx.vault.invoke({
      command: 'home.add_warranty',
      input: {
        item_id: String(input.item_id ?? ''),
        starts_on: String(input.starts_on ?? ''),
        ends_on: String(input.ends_on ?? ''),
        ...(input.provider_party_id != null
          ? { provider_party_id: String(input.provider_party_id) }
          : {}),
        ...(input.claim_uri != null ? { claim_uri: String(input.claim_uri) } : {}),
      },
      purpose: 'dpv:ServiceProvision',
    });
    return { status: 200, body: outcome };
  } catch (err) {
    return { status: 200, body: { status: 'denied', reason: err.message, code: err.code } };
  }
};
