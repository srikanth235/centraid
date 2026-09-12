/**
 * The security review: compromised / weak / reused counts plus the needs-
 * attention items, in the secret-free row shape. Weak and reused come from
 * the `locker.watchtower` command — derived INSIDE the vault's sealed
 * boundary (#293), the unseal receipted — compromised is the one
 * stored breach flag. Only non-trashed items are reviewed.
 */

import { readWindow } from "../../_shared/paged-reads.ts";
import {
  LOCKER_ITEM_COLUMNS,
  decorate,
  readStarred,
  readTags,
  readWatchtower,
} from "./items.ts";
import type { RawItem } from "./items.ts";

/** How many items this shelf shows. */
const WATCH_ROWS = 2000;

export default async function watchtowerHandler({ ctx }: HandlerArgs) {
  try {
    // WALKED, NOT CLAMPED (#1020, R-1020-35). A 2,000-row window asked for as
    // one page came back 500 rows long with a `next` cursor nobody read, so
    // Watchtower audited a quarter of the vault and reported it as all of it.
    const rows = await readWindow<RawItem>(
      ctx,
      {
        name: "locker.watchtower.items",
        select: LOCKER_ITEM_COLUMNS,
        from: "locker_item",
        where: "deleted_at IS NULL",
        order: {
          sortColumn: "updated_at",
          pkColumn: "item_id",
          descending: true,
        },
      },
      WATCH_ROWS
    );
    const ids = rows.map((r) => r.item_id);
    const [tagsByItem, starredIds, watchByItem] = await Promise.all([
      readTags(ctx, ids),
      readStarred(ctx, ids),
      readWatchtower(ctx),
    ]);
    const decorated = decorate(rows, tagsByItem, starredIds, watchByItem);
    const affected = decorated.filter(
      (it) => it.compromised || it.weak || it.reused
    );
    return {
      compromised: decorated.filter((it) => it.compromised).length,
      weak: decorated.filter((it) => it.weak).length,
      reused: decorated.filter((it) => it.reused).length,
      items: affected,
    };
  } catch (error) {
    const e = error as { code?: string; message?: string };
    return {
      compromised: 0,
      weak: 0,
      reused: 0,
      items: [],
      vaultDenied: { code: e.code, message: e.message },
    };
  }
}
