/**
 * The 50k-row reconnect corpus and the seat log page that catches it up
 * (#996, W5). Used by the CLIENT-SIDE TIMING probe, which gates on a
 * wall-clock ceiling and therefore lives in the isolated nightly scale lane
 * (`tests/scale/mobile-reconnect-to-fresh.scale.test.ts`).
 *
 * WHAT THIS STOPPED BEING. It used to shape a bootstrap PAGE and a change
 * BATCH: shapes, entities, declared columns, `shapeId` on every row. A seat
 * holds the vault's own file, so the corpus is rows of a real table and the
 * missed changes are rows of the gateway's LOG — the same wire the applier
 * reads on a real catch-up.
 */
import type { SeatLogPageWire, SeatLogRowWire } from "@centraid/core/protocol";

/** Year-3 replica rows on a phone (tests/journeys.json `volumes.year3-replica`). */
export const REPLICA_ROWS = 50_000;
/** Changes committed while the phone was away. */
export const MISSED_CHANGES = 200;
/** The page a Photos/Docs screen asks for. */
export const SCREEN_PAGE = 200;

export const TABLE = "core_content_item";
export const EPOCH = "replica-1";
export const SCHEMA_EPOCH = 1;

/** The one table this probe reads, as the vault declares it. */
export const CORPUS_DDL = `
  CREATE TABLE IF NOT EXISTS ${TABLE} (
    content_id TEXT PRIMARY KEY,
    title      TEXT,
    deleted_at TEXT,
    created_at TEXT NOT NULL,
    row_version INTEGER NOT NULL DEFAULT 1
  ) STRICT;
  CREATE INDEX IF NOT EXISTS idx_content_created
    ON ${TABLE}(created_at DESC, content_id);
`;

/** Clock-free: the same rows on every host. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d_2b_79_f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

export function contentId(index: number): string {
  return `content-${index.toString().padStart(6, "0")}`;
}

export interface CorpusRow {
  content_id: string;
  title: string;
  deleted_at: null;
  created_at: string;
}

export function corpus(): CorpusRow[] {
  const random = seededRandom(883_002);
  return Array.from({ length: REPLICA_ROWS }, (_unused, index) => {
    const capturedMs =
      Date.UTC(2023, 0, 1) + Math.floor(random() * 3 * 365 * 86_400_000);
    return {
      content_id: contentId(index),
      title: `Item ${index}`,
      deleted_at: null,
      created_at: new Date(capturedMs).toISOString(),
    };
  });
}

/**
 * The commits the phone missed, as ONE log page.
 *
 * Dated past every seeded row, so a newest-first screen page must carry them:
 * a probe whose changes could sort out of the window would measure nothing.
 */
export function missedLogPage(since: number): SeatLogPageWire {
  const rows: SeatLogRowWire[] = Array.from(
    { length: MISSED_CHANGES },
    (_unused, index) => ({
      seq: since + index + 1,
      commitSeq: since + index + 1,
      schemaEpoch: SCHEMA_EPOCH,
      ddlVersion: 1,
      table: TABLE,
      op: "update" as const,
      pk: [contentId(index)],
      row: {
        content_id: contentId(index),
        title: `Renamed while away ${index}`,
        deleted_at: null,
        created_at: new Date(Date.UTC(2027, 0, 1) + index * 1000).toISOString(),
        row_version: 2,
      },
      producer: "gateway",
      committedAt: new Date(Date.UTC(2027, 0, 1)).toISOString(),
    })
  );
  return {
    vaultId: "vault-a",
    epoch: EPOCH,
    schemaEpoch: SCHEMA_EPOCH,
    ddlVersion: 1,
    floor: 0,
    watermark: since + MISSED_CHANGES,
    next: since + MISSED_CHANGES,
    hasMore: false,
    rows,
  };
}
