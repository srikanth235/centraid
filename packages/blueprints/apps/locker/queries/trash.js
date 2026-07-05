/**
 * Trashed items with their purge dates, in the secret-free row shape. A
 * trashed item keeps its star and tags so a restore is lossless; it rides the
 * same decorate() path as the live window.
 *
 * @type {import('@centraid/openclaw-plugin').QueryHandler}
 */

import { decorate, readTags, readStarred } from './items.js';

export default async ({ ctx }) => {
  const purpose = 'dpv:ServiceProvision';
  try {
    const res = await ctx.vault.read({
      entity: 'locker.item',
      where: [{ column: 'deleted_at', op: 'not-null' }],
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
    return { items: decorate(rows, tagsByItem, starredIds) };
  } catch (err) {
    return { items: [], vaultDenied: { code: err.code, message: err.message } };
  }
};
