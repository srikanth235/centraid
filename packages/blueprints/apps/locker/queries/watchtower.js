/**
 * The security review: compromised / weak / reused counts plus the needs-
 * attention items, in the secret-free row shape. Weak and reused come from
 * the `locker.watchtower` command — derived INSIDE the vault's sealed
 * boundary (issue #293), the unseal receipted — compromised is the one
 * stored breach flag. Only non-trashed items are reviewed.
 *
 * @type {import('@centraid/openclaw-plugin').QueryHandler}
 */

import { decorate, readTags, readStarred, readWatchtower } from './items.js';

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
    const [tagsByItem, starredIds, watchByItem] = await Promise.all([
      readTags(ctx, ids, purpose),
      readStarred(ctx, ids, purpose),
      readWatchtower(ctx, purpose),
    ]);
    const decorated = decorate(rows, tagsByItem, starredIds, watchByItem);
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
