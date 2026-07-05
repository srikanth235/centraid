/**
 * The security review: compromised / weak / reused counts plus the needs-
 * attention items, in the secret-free row shape. Everything is derived
 * server-side from the passwords the vault holds (weak = low strength, reused
 * = a login password shared by ≥2 logins) except compromised, the one stored
 * breach flag. Only non-trashed items are reviewed.
 *
 * @type {import('@centraid/openclaw-plugin').QueryHandler}
 */

import { decorate, readTags, readStarred } from './items.js';

export default async ({ ctx }) => {
  const purpose = 'dpv:ServiceProvision';
  try {
    const res = await ctx.vault.read({
      entity: 'locker.item',
      where: [{ column: 'deleted_at', op: 'is-null' }],
      orderBy: { column: 'updated_at', dir: 'desc' },
      limit: 2000,
      purpose,
    });
    const rows = res.rows ?? [];
    const ids = rows.map((r) => r.item_id);
    const [tagsByItem, starredIds] = await Promise.all([
      readTags(ctx, ids, purpose),
      readStarred(ctx, ids, purpose),
    ]);
    const decorated = decorate(rows, tagsByItem, starredIds);
    const affected = decorated.filter((it) => it.compromised || it.weak || it.reused);
    return {
      compromised: decorated.filter((it) => it.compromised).length,
      weak: decorated.filter((it) => it.weak).length,
      reused: decorated.filter((it) => it.reused).length,
      items: affected,
    };
  } catch (err) {
    return {
      compromised: 0,
      weak: 0,
      reused: 0,
      items: [],
      vaultDenied: { code: err.code, message: err.message },
    };
  }
};
