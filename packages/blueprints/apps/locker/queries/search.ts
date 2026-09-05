/**
 * Match items by title, username or url and return the same secret-free row
 * shape as the items query. The matching runs server-side over the bounded
 * item window — including fields (username, url) the payload never returns —
 * so search can find a login by its username without that username ever
 * leaving the vault in a list. Trashed items never match. A consent denial is
 * a first-class outcome the UI renders as the access state.
 *
 * THE ROWS ARE THE ANSWER; WATCHTOWER IS A DECORATION (#928). Matching runs
 * over the same rows a replica seat holds, so this query answers locally, and
 * the weak/reused/last4 decoration is asked for as `optional` — a search whose
 * Watchtower is out of reach returns its rows undecorated rather than nothing.
 */

import {
  decorate,
  readTags,
  readStarred,
  readWatchtower,
  rethrowIfLocalReadRefused,
} from "./items.ts";
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
      readWatchtower(ctx, purpose, { optional: true }),
    ]);
    return { items: decorate(matched, tagsByItem, starredIds, watchByItem) };
  } catch (error) {
    rethrowIfLocalReadRefused(error);
    const e = error as { code?: string; message?: string };
    return { items: [], vaultDenied: { code: e.code, message: e.message } };
  }
}
