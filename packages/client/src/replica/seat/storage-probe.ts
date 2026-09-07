// HOW MUCH OF THE VAULT THIS BROWSER CAN ACTUALLY HOLD (#996, R15, OQ-2).
//
// The PWA is a cache of the vault and says so. What it can cache is not a
// browser name: Safari's OPFS ceiling is the reason the question exists, but
// hard-coding `isSafari` would be wrong on a Safari with a generous quota and
// wrong again on the next browser that ships a tight one. OQ-2 was settled as
// "decided by a storage-estimate probe at bootstrap", and this is the probe.
//
// THE FALLBACK IS ROWS MINUS FTS, AND IT IS A REAL PRODUCT DECISION, not a
// degradation. The search index is the single largest removable part of the
// file and it is the ONE part with a working online substitute: a seat without
// it answers every screen from local rows and asks the gateway when the member
// searches. Dropping rows instead would break every screen a little, which is
// the worse trade in every direction.
//
// AND IT IS NOT FREE. The snapshot keeps the FTS sync TRIGGERS, so dropping
// the shadow tables without dropping them fails on the seat's first write with
// `no such table: main.fts_…`. That is the "seat-side rebuild step attached"
// wave 1 named when it declined to drop the tables in the snapshot pipeline;
// `reduceSeatToRowsMinusFts` is that step, and it drops both together.

import type { SeatSqliteDriver } from "./driver.js";
import { SeatBootstrapNoRoomError } from "./seat-bootstrap-no-room-error.js";

/** What this seat's file contains. */
export type SeatContents = "full" | "rows-minus-fts";

/**
 * What the FTS index costs, as a fraction of the expanded file.
 *
 * MEASURED on the golden year-3 vault: the shadow tables are 12.6 MB of a
 * 64.4 MB snapshot. Used only to decide whether dropping them would even
 * help — the reduction itself measures the real file rather than trusting
 * this number.
 */
export const SEAT_FTS_SHARE = 0.2;

/** `navigator.storage.estimate()`, or whatever the host can say. */
export interface SeatStorageEstimate {
  readonly quota?: number | undefined;
  readonly usage?: number | undefined;
}

export interface SeatContentsChoice {
  readonly contents: SeatContents;
  /** Bytes the chosen contents are expected to need, once expanded. */
  readonly expectedBytes: number;
  /** Bytes the host says are available, or undefined when it will not say. */
  readonly available: number | undefined;
  /** Why this and not the other. One line, for the shell. */
  readonly reason: string;
}

export interface SeatContentsInput {
  readonly estimate?: SeatStorageEstimate | undefined;
  /** The expanded size of the file, from the door's size and the expansion. */
  readonly expandedBytes: number;
  /** Keep this much free after the file lands, so the browser does not evict it. */
  readonly headroomBytes?: number;
  readonly ftsShare?: number;
}

/**
 * A margin over the file itself, because a storage bucket at 100% is a bucket
 * the browser evicts. Twenty per cent of the file, floored at 32 MB: the
 * floor matters on a small vault, where a percentage of a small number is not
 * enough room for a WAL and a re-bootstrap.
 */
function headroomFor(expanded: number): number {
  return Math.max(32 * 1024 * 1024, Math.round(expanded * 0.2));
}

/**
 * Full or rows-minus-FTS, from what the host will say about its quota.
 *
 * An absent estimate answers `full`: refusing to hold the index because a
 * browser declined to guess would make every such browser a worse seat for no
 * measured reason.
 */
export function chooseSeatContents(
  input: SeatContentsInput
): SeatContentsChoice {
  const headroom = input.headroomBytes ?? headroomFor(input.expandedBytes);
  const quota = input.estimate?.quota;
  const usage = input.estimate?.usage ?? 0;
  const available =
    typeof quota === "number" && Number.isFinite(quota)
      ? Math.max(0, quota - usage)
      : undefined;
  if (available === undefined) {
    return {
      contents: "full",
      expectedBytes: input.expandedBytes,
      available: undefined,
      reason: "this browser does not report a storage quota",
    };
  }
  if (input.expandedBytes + headroom <= available) {
    return {
      contents: "full",
      expectedBytes: input.expandedBytes,
      available,
      reason: "the whole vault fits, search included",
    };
  }
  const reduced = Math.round(
    input.expandedBytes * (1 - (input.ftsShare ?? SEAT_FTS_SHARE))
  );
  if (reduced + headroom <= available) {
    return {
      contents: "rows-minus-fts",
      expectedBytes: reduced,
      available,
      reason: "the rows fit but the search index does not; search runs online",
    };
  }
  // NOT A SILENT DOWNGRADE TO NOTHING. A seat that cannot hold the rows is a
  // remote-only client, and that is a decision for the member and the shell —
  // this function's job is to refuse rather than to invent a third contents.
  throw new SeatBootstrapNoRoomError(reduced + headroom, available);
}

/**
 * Drop the search index and the triggers that maintain it, then reclaim.
 *
 * BOTH, TOGETHER. The retained FTS sync triggers write to the shadow tables on
 * every insert; dropping the tables alone leaves a file that reads fine and
 * fails on the first applied commit, which is the worst possible time to find
 * out. Returns what it dropped.
 */
export function reduceSeatToRowsMinusFts(driver: SeatSqliteDriver): {
  readonly tables: readonly string[];
  readonly triggers: readonly string[];
} {
  const quoted = (name: string): string => `"${name.replaceAll('"', '""')}"`;
  const triggers = driver
    .all<{ name: string }>(
      `SELECT name FROM sqlite_schema
        WHERE type = 'trigger' AND sql LIKE '%fts_%' ORDER BY name`
    )
    .map((row) => row.name);
  for (const trigger of triggers)
    driver.exec(`DROP TRIGGER IF EXISTS ${quoted(trigger)}`);
  const tables = driver
    .all<{ name: string }>(
      `SELECT name FROM sqlite_schema
        WHERE type = 'table' AND sql LIKE '%USING fts5%' ORDER BY name`
    )
    .map((row) => row.name);
  for (const table of tables)
    driver.exec(`DROP TABLE IF EXISTS ${quoted(table)}`);
  // The drop frees pages; only VACUUM gives them back to the filesystem, and
  // giving them back is the entire reason for doing this.
  driver.exec("VACUUM");
  return { tables, triggers };
}
