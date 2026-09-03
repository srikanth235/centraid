import { decorate, readTags, readStarred, readWatchtower } from "./items.ts";
import type { RawItem } from "./items.ts";

export default async function searchHandler({
  input,
  ctx,
}: {
  input?: Record<string, unknown>;
  ctx: HandlerCtx;
}) {
  const purpose = "dpv:ServiceProvision";
  const term = String(input?.term ?? "")
    .trim()
    .toLowerCase();
  if (!term) return { items: [] };
  try {
    const res = await ctx.vault.read({
      entity: "locker.item",
      where: [{ column: "deleted_at", op: "is-null" }],
      orderBy: { column: "updated_at", dir: "desc" },
      limit: 500,
      purpose,
    });
    const matched = ((res.rows ?? []) as unknown as RawItem[]).filter((it) => {
      return (
        String(it.title || "")
          .toLowerCase()
          .includes(term) ||
        String(it.username || "")
          .toLowerCase()
          .includes(term) ||
        String(it.url || "")
          .toLowerCase()
          .includes(term)
      );
    });
    const ids = matched.map((r) => r.item_id);
    const [tagsByItem, starredIds, watchByItem] = await Promise.all([
      readTags(ctx, ids, purpose),
      readStarred(ctx, ids, purpose),
      readWatchtower(ctx, purpose),
    ]);
    return { items: decorate(matched, tagsByItem, starredIds, watchByItem) };
  } catch (error) {
    const e = error as { code?: string; message?: string };
    return { items: [], vaultDenied: { code: e.code, message: e.message } };
  }
}
