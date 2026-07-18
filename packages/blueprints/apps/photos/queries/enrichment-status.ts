/**
 * Whether face-proposer enrichment is enabled for this vault (issue #352
 * phase 3/4): a straight read of `enrich.policy` for the photos domain — an
 * app-readable MIRROR of the owner's settings
 * (packages/vault/src/schema/enrich.ts), never the settings bag itself
 * (that stays owner-only, GET/PATCH /centraid/_vault/enrich). `tier` is
 * one of 'off' | 'local' | 'model'; the toolbar's "Detect faces now" only
 * fires when it isn't 'off' — when it is, the UI says so plainly rather
 * than showing a button that would silently no-op.
 *
 * @type {import('@centraid/openclaw-plugin').QueryHandler}
 */

interface RawPolicy {
  tier?: string;
}

export default async ({ ctx }: HandlerArgs) => {
  const purpose = 'dpv:ServiceProvision';
  try {
    const result = await ctx.vault.read({
      entity: 'enrich.policy',
      where: [{ column: 'domain', op: 'eq', value: 'photos' }],
      purpose,
    });
    const row = ((result.rows ?? []) as unknown as RawPolicy[])[0];
    return { tier: row?.tier ?? 'off' };
  } catch (err) {
    const e = err as { code?: string; message?: string };
    if (e.code === 'VAULT_CONSENT') {
      return { tier: null, vaultDenied: { code: e.code, message: e.message } };
    }
    return { tier: null, error: String(e.message ?? err) };
  }
};
