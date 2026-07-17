/*
 * Repricing backfill (issue #445).
 *
 * Prices drift and the catalog gains coverage over time, so `items.cost_usd`
 * frozen under an old (or absent) rate goes wrong: a then-unknown model reads
 * NULL → $0 in Insights, and a since-repriced model reads a stale figure. This
 * is the ONLY sanctioned rewriter of the frozen cost: it recomputes each step/
 * agent item's cost from its FROZEN token counts against the CURRENT catalog,
 * and where the result differs it rewrites `items.cost_usd` and re-derives the
 * owning turn's `total_cost_usd` with the same SUM shape `finishTurn` uses.
 *
 * Token columns are the truth and are NEVER touched. `conversation_digest`
 * rows (issue #438 archived rollups) are frozen copies and out of scope — this
 * only sees live `items`/`turns`.
 *
 * Bounded and resumable: one pass scans at most `maxScan` items from a caller-
 * held rowid cursor and writes at most `maxWrites` differing rows, returning
 * the cursor to resume from. Steady state is ~free — a clean row recomputes to
 * the same value and writes nothing; a second pass over unchanged data is a
 * no-op (idempotent).
 */

import type { DatabaseSync } from 'node:sqlite';
import { costForUsage } from '../model-pricing.js';

export interface RepriceOptions {
  /** Resume point — process items with `rowid > cursor`. Default 0 (start). */
  cursor?: number;
  /** Max items examined per pass (bounds CPU). Default 5000. */
  maxScan?: number;
  /** Max differing items rewritten per pass (bounds IO / chunks convergence). Default 1000. */
  maxWrites?: number;
}

export interface RepriceResult {
  /** Items whose cost changed and were rewritten. */
  itemsRepriced: number;
  /** Distinct turns whose `total_cost_usd` was re-derived. */
  turnsRederived: number;
  /** Items examined this pass. */
  scanned: number;
  /** Cursor to pass next time; wraps to 0 once the table tail is reached. */
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
}

// Below this the two costs are the same money — keeps float noise from forcing
// a write (and matches the ledger's 4-dp rounding elsewhere).
const EPSILON = 1e-9;

function differs(a: number | null, b: number | null): boolean {
  if (a === null || b === null) return a !== b; // NULL↔value is a real change
  return Math.abs(a - b) > EPSILON;
}

/**
 * Run one bounded repricing pass over a journal handle's live ledger. Safe to
 * call repeatedly; only rows whose recomputed cost differs are written.
 */
export function repriceLedger(db: DatabaseSync, opts: RepriceOptions = {}): RepriceResult {
  const cursor = opts.cursor ?? 0;
  const maxScan = Math.max(1, opts.maxScan ?? 5000);
  const maxWrites = Math.max(1, opts.maxWrites ?? 1000);

  const rows = db
    .prepare(
      `SELECT rowid, turn_id, model, input_tokens, output_tokens,
              cache_read_tokens, cache_write_tokens, cost_usd
         FROM items
        WHERE rowid > ? AND kind IN ('step','agent') AND model IS NOT NULL
        ORDER BY rowid ASC
        LIMIT ?`,
    )
    .all(cursor, maxScan) as unknown as ItemRow[];

  const updateItem = db.prepare(`UPDATE items SET cost_usd = ? WHERE rowid = ?`);
  // Same SUM shape as finishTurn — NULL when every child cost is NULL.
  const rederiveTurn = db.prepare(
    `UPDATE turns SET total_cost_usd = (
        SELECT SUM(cost_usd) FROM items
         WHERE turn_id = ? AND kind IN ('step','agent'))
      WHERE id = ?`,
  );

  const affectedTurns = new Set<string>();
  let itemsRepriced = 0;
  let lastRowid = cursor;

  // SAVEPOINT (not BEGIN) so this nests safely if the caller already holds a
  // transaction — the sweep runs several duties per tick.
  db.prepare('SAVEPOINT reprice').run();
  try {
    for (const row of rows) {
      lastRowid = row.rowid;
      const recomputed =
        costForUsage(row.model ?? undefined, {
          ...(row.input_tokens !== null ? { inputTokens: row.input_tokens } : {}),
          ...(row.output_tokens !== null ? { outputTokens: row.output_tokens } : {}),
          ...(row.cache_read_tokens !== null ? { cacheReadTokens: row.cache_read_tokens } : {}),
          ...(row.cache_write_tokens !== null ? { cacheWriteTokens: row.cache_write_tokens } : {}),
        }) ?? null;
      if (!differs(recomputed, row.cost_usd)) continue;
      updateItem.run(recomputed, row.rowid);
      affectedTurns.add(row.turn_id);
      itemsRepriced += 1;
      if (itemsRepriced >= maxWrites) break;
    }
    for (const turnId of affectedTurns) rederiveTurn.run(turnId, turnId);
    db.prepare('RELEASE reprice').run();
  } catch (err) {
    db.prepare('ROLLBACK TO reprice').run();
    db.prepare('RELEASE reprice').run();
    throw err;
  }

  // Fewer rows than asked for ⇒ tail reached; wrap to re-sweep from the start.
  const nextCursor = rows.length < maxScan && itemsRepriced < maxWrites ? 0 : lastRowid;
  return {
    itemsRepriced,
    turnsRederived: affectedTurns.size,
    scanned: rows.length,
    nextCursor,
  };
}
