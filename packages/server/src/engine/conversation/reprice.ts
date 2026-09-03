import type { DatabaseSync } from "node:sqlite";

import { costForUsage } from "../model-pricing.js";

export interface RepriceOptions {
  cursor?: number;
  maxScan?: number;
  maxWrites?: number;
}

export interface RepriceResult {
  itemsRepriced: number;
  turnsRederived: number;
  scanned: number;
  nextCursor: number;
}

interface ItemRow {
  rowid: number;
  turn_id: string;
  model: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  cost_usd: number | null;
  cost_source: string | null;
}

const EPSILON = 1e-9;

function differs(a: number | null, b: number | null): boolean {
  if (a === null || b === null) return a !== b; // NULL↔value is a real change
  return Math.abs(a - b) > EPSILON;
}

export function repriceLedger(
  db: DatabaseSync,
  opts: RepriceOptions = {}
): RepriceResult {
  const cursor = opts.cursor ?? 0;
  const maxScan = Math.max(1, opts.maxScan ?? 5000);
  const maxWrites = Math.max(1, opts.maxWrites ?? 1000);

  const rows = db
    .prepare(
      `SELECT rowid, turn_id, model, input_tokens, output_tokens,
              cache_read_tokens, cache_write_tokens, cost_usd, cost_source
         FROM items
        WHERE rowid > ? AND kind IN ('step','delegate') AND model IS NOT NULL
          AND (cost_source IS NULL OR cost_source = 'estimated')
        ORDER BY rowid ASC
        LIMIT ?`
    )
    .all(cursor, maxScan) as unknown as ItemRow[];

  const updateItem = db.prepare(
    `UPDATE items SET cost_usd = ?, cost_source = CASE WHEN ? IS NULL THEN NULL ELSE 'estimated' END WHERE rowid = ?`
  );
  const rederiveTurn = db.prepare(
    `UPDATE turns SET total_cost_usd = (
        SELECT SUM(cost_usd) FROM items
         WHERE turn_id = ? AND kind IN ('step','delegate'))
      WHERE id = ?`
  );

  const affectedTurns = new Set<string>();
  let itemsRepriced = 0;
  let lastRowid = cursor;

  db.prepare("SAVEPOINT reprice").run();
  try {
    for (const row of rows) {
      lastRowid = row.rowid;
      if (row.cost_source === "harness") continue;
      const recomputed =
        costForUsage(row.model ?? undefined, {
          ...(row.input_tokens === null
            ? {}
            : { inputTokens: row.input_tokens }),
          ...(row.output_tokens === null
            ? {}
            : { outputTokens: row.output_tokens }),
          ...(row.cache_read_tokens === null
            ? {}
            : { cacheReadTokens: row.cache_read_tokens }),
          ...(row.cache_write_tokens === null
            ? {}
            : { cacheWriteTokens: row.cache_write_tokens }),
        }) ?? null;
      if (!differs(recomputed, row.cost_usd)) continue;
      updateItem.run(recomputed, recomputed, row.rowid);
      affectedTurns.add(row.turn_id);
      itemsRepriced += 1;
      if (itemsRepriced >= maxWrites) break;
    }
    for (const turnId of affectedTurns) rederiveTurn.run(turnId, turnId);
    db.prepare("RELEASE reprice").run();
  } catch (error) {
    db.prepare("ROLLBACK TO reprice").run();
    db.prepare("RELEASE reprice").run();
    throw error;
  }

  const nextCursor =
    rows.length < maxScan && itemsRepriced < maxWrites ? 0 : lastRowid;
  return {
    itemsRepriced,
    turnsRederived: affectedTurns.size,
    scanned: rows.length,
    nextCursor,
  };
}
