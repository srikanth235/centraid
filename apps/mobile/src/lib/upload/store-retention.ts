// The queue ledger's TAIL: what a screen still needs, what a failure offers
// the member, and what may be forgotten (#1014, P7/P25). Split out of
// `store.ts` so that file stays under the governance line cap; every function
// here is one statement over the driver the store already owns.

import type { UploadSqliteDriver } from "../replica/expo-sqlite-driver";
import type { UploadItem } from "./store";
import { PENDING_PAGE_LIMIT, RECENT_PAGE_LIMIT } from "./store-limits";
import { toItem } from "./store-rows";
import type { ItemRow } from "./store-rows";

type Driver = Pick<UploadSqliteDriver, "run" | "all">;

/**
 * The newest slice of the ledger — what a screen drawing device rows needs
 * (#1014, P25). `UploadQueueStore.all()` materialized up to 100,000 rows on
 * EVERY refresh of Photos' timeline engine, on a phone whose whole roll is the
 * queue's history. `sweepTerminalItems` keeps the tail short; this keeps a
 * missed sweep from costing the roll.
 */
export function recentItems(
  driver: Driver,
  limit: number = RECENT_PAGE_LIMIT
): UploadItem[] {
  return driver
    .all<ItemRow>(
      "SELECT * FROM upload_item ORDER BY created_order DESC LIMIT ?",
      [limit]
    )
    .map(toItem);
}

/** Terminally failed rows the member has not dismissed, oldest first (P7). */
export function failedItems(
  driver: Driver,
  limit: number = PENDING_PAGE_LIMIT
): UploadItem[] {
  return driver
    .all<ItemRow>(
      `SELECT * FROM upload_item
         WHERE state = 'failed' AND dismissed_at IS NULL
         ORDER BY created_order LIMIT ?`,
      [limit]
    )
    .map(toItem);
}

/**
 * Non-terminal rows that failed at least once and are waiting to try again —
 * INCLUDING rows inside a backoff window (#1014).
 *
 * The member-facing failure list used to read `pending()`, which now hides a
 * deferred row from the DRAIN; hiding it from the readout too would make a
 * refusal vanish from Backup health for minutes at a time.
 */
export function retryingItems(
  driver: Driver,
  limit: number = PENDING_PAGE_LIMIT
): UploadItem[] {
  return driver
    .all<ItemRow>(
      `SELECT * FROM upload_item
         WHERE state NOT IN ('settled', 'failed') AND last_error IS NOT NULL
         ORDER BY created_order LIMIT ?`,
      [limit]
    )
    .map(toItem);
}

export function failedItemCount(driver: Driver): number {
  return (
    driver.all<{ count: number }>(
      `SELECT COUNT(*) AS count FROM upload_item
         WHERE state = 'failed' AND dismissed_at IS NULL`
    )[0]?.count ?? 0
  );
}

/** Member-driven retry: back to `pending` with the attempt budget reset. */
export function retryFailedItem(driver: Driver, itemId: string): void {
  driver.run(
    `UPDATE upload_item
        SET state = 'pending', attempts = 0, last_error = NULL,
            next_attempt_at = NULL, dismissed_at = NULL
      WHERE item_id = ? AND state = 'failed'`,
    [itemId]
  );
}

export function dismissFailedItem(driver: Driver, itemId: string): void {
  driver.run(
    "UPDATE upload_item SET dismissed_at = ? WHERE item_id = ? AND state = 'failed'",
    [new Date().toISOString(), itemId]
  );
}

/** Do not touch this row before `at`; the drain's page query skips it. */
export function deferItemUntil(
  driver: Driver,
  itemId: string,
  at: string
): void {
  driver.run("UPDATE upload_item SET next_attempt_at = ? WHERE item_id = ?", [
    at,
    itemId,
  ]);
}

/**
 * Drop terminal rows nothing is waiting on (#1014, P25).
 *
 * A settled row is deleted only once its follow-up has settled too — the
 * follow-up's FK cascades from here, so deleting first would silently drop a
 * canonical write that never happened. A failed row is deleted only after the
 * member dismissed it: an undismissed failure is the only place its reason is
 * written down.
 *
 * `keep` is a floor, not a promise of pruning: the newest `keep` terminal rows
 * stay whatever their age, so a phone that settled 400 photographs a minute
 * ago still shows them as backed up.
 */
export function sweepTerminalItems(
  driver: Driver,
  options: { olderThanMs: number; keep?: number; now?: number }
): number {
  const cutoff = new Date(
    (options.now ?? Date.now()) - options.olderThanMs
  ).toISOString();
  const keep = options.keep ?? RECENT_PAGE_LIMIT;
  const before = terminalCount(driver);
  driver.run(
    `DELETE FROM upload_item
      WHERE item_id IN (
        SELECT item_id FROM upload_item
         WHERE (
           (state = 'settled' AND settled_at IS NOT NULL AND settled_at < ?
            AND item_id NOT IN (SELECT item_id FROM upload_followup))
           OR (state = 'failed' AND dismissed_at IS NOT NULL AND dismissed_at < ?)
         )
         ORDER BY created_order
         LIMIT MAX(0, (SELECT COUNT(*) FROM upload_item
                        WHERE state IN ('settled', 'failed')) - ?)
      )`,
    [cutoff, cutoff, keep]
  );
  driver.run(
    "DELETE FROM upload_part WHERE item_id NOT IN (SELECT item_id FROM upload_item)"
  );
  return before - terminalCount(driver);
}

function terminalCount(driver: Driver): number {
  return (
    driver.all<{ count: number }>(
      "SELECT COUNT(*) AS count FROM upload_item WHERE state IN ('settled', 'failed')"
    )[0]?.count ?? 0
  );
}
