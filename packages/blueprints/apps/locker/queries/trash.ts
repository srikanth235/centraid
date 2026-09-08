/**
 * Trashed items with their purge dates, in the secret-free row shape. A
 * trashed item keeps its star and tags so a restore is lossless; it rides the
 * same decorate() path as the live window.
 */

import {
  LOCKER_ITEM_COLUMNS,
  decorate,
  readStarred,
  readTags,
  rethrowIfLocalReadRefused,
} from "./items.ts";
import type { RawItem } from "./items.ts";

/** How many items this shelf shows. */
const TRASH_ROWS = 2000;

export default async function trash({ ctx }: HandlerArgs) {
  try {
    const res = await ctx.vault.page<RawItem>({
      query: {
        name: "locker.trash.items",
        select: LOCKER_ITEM_COLUMNS,
        from: "locker_item",
        where: "deleted_at IS NOT NULL",
        order: {
          sortColumn: "updated_at",
          pkColumn: "item_id",
          descending: true,
        },
      },
      limit: TRASH_ROWS,
    });
    const rows = res.rows;
    const ids = rows.map((r) => r.item_id);
    const [tagsByItem, starredIds] = await Promise.all([
      readTags(ctx, ids),
      readStarred(ctx, ids),
    ]);
    return { items: decorate(rows, tagsByItem, starredIds) };
  } catch (error) {
    rethrowIfLocalReadRefused(error);
    const e = error as { code?: string; message?: string };
    return { items: [], vaultDenied: { code: e.code, message: e.message } };
  }
}
