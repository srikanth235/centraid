/**
 * Trashed items with their purge dates, in the secret-free row shape. A
 * trashed item keeps its star and tags so a restore is lossless; it rides the
 * same decorate() path as the live window.
 */

import { decorate, readTags, readStarred } from "./items.ts";
import type { RawItem } from "./items.ts";

export default async function trash({ ctx }: HandlerArgs) {
  try {
    const res = await ctx.vault.read({
      entity: "locker.item",
      where: [{ column: "deleted_at", op: "not-null" }],
      orderBy: { column: "updated_at", dir: "desc" },
      limit: 2000,
    });
    const rows = (res.rows ?? []) as unknown as RawItem[];
    const ids = rows.map((r) => r.item_id);
    const [tagsByItem, starredIds] = await Promise.all([
      readTags(ctx, ids),
      readStarred(ctx, ids),
    ]);
    return { items: decorate(rows, tagsByItem, starredIds) };
  } catch (error) {
    const e = error as { code?: string; message?: string };
    return { items: [], vaultDenied: { code: e.code, message: e.message } };
  }
}
