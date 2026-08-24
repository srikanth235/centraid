// The Vault Atlas census/graph/pulse computations (#441 Part B, B4
// items 2-4). These are the read-only payload builders the gateway's
// `/_vault/atlas/*` routes wrap. Kept in the vault package (not the gateway)
// so the ghost-semantics invariant can be tested directly against a migrated
// `:memory:` vault, and so the pack mapping and `table-stats.ts` sit next to
// their single caller.
//
// FK ≠ core_link is the load-bearing distinction (#441 "the trap this
// design must not fall into"). Two DIFFERENT relation mechanisms travel as
// SEPARATE collections in the graph payload and must never be conflated:
//   - fkEdges     — schema-enforced FK columns; an edge "carries" when child
//                   rows populate the column (fill = COUNT WHERE col NOT NULL).
//                   A ghost is fill === 0, NEVER "no core_link on this pair".
//   - authoredLinks — user/agent-authored `core_link` rows, typed by a SKOS
//                   concept, free to join any two kinds.

import type { DatabaseSync } from "node:sqlite";

import { countRows } from "./atlas-graph.js";
import { atlasTables } from "./atlas.js";
import type { AtlasPackKind } from "./atlas.js";
import { dbSizeBreakdown } from "./table-stats.js";
import type { TableStatsMethod } from "./table-stats.js";

export {
  ATLAS_GRAPH_CENTER,
  ATLAS_PULSE_WINDOW_DAYS,
  atlasGraph,
  atlasPulse,
  type AtlasAuthoredLink,
  type AtlasFkEdge,
  type AtlasGraphNode,
  type AtlasGraphPayload,
  type AtlasPulseDay,
  type AtlasPulsePayload,
  type AtlasPulseSeries,
} from "./atlas-graph.js";

// ───────────────────────────────────────────────────────────────────────────
// Census (GET /_vault/atlas/stats)
// ───────────────────────────────────────────────────────────────────────────

export interface AtlasCensusTable {
  logical: string;
  physical: string;
  table: string;
  label: string;
  /** Live row count (COUNT(*) — an owner ops screen, computed on request). */
  rows: number;
  /** Bytes attributable to this table + its indexes; null under `estimate`. */
  bytes: number | null;
  /** Pages attributable to this table + its indexes; null under `estimate`. */
  pages: number | null;
}

export interface AtlasCensusPack {
  pack: string;
  packLabel: string;
  packKind: AtlasPackKind;
  file: "vault" | "journal";
  tables: AtlasCensusTable[];
  /** Pack totals — rows always; bytes null when any member is byte-less. */
  rows: number;
  bytes: number | null;
}

export interface AtlasCensusPayload {
  generatedAt: string;
  /** `dbstat` (byte breakdown) or `estimate` (row counts only) — honest. */
  method: TableStatsMethod;
  /** Whole-file size, vault.db + journal.db. */
  fileBytesTotal: number;
  packs: AtlasCensusPack[];
  totals: {
    rows: number;
    bytes: number | null;
    /** Every kind the ontology defines (ontology packs only). */
    kinds: number;
    /** How many of those kinds have at least one row. */
    populatedKinds: number;
  };
}

/**
 * Grouped census of the vault (#441): per-table rows/bytes wrapped
 * with the pack mapping. Bytes come from `table-stats.ts` (dbstat, with its
 * documented `estimate` fallback); rows are a COUNT(*) per table (the dbstat
 * method omits rows by design, and the census header wants "214 people").
 */
export function atlasCensus(
  vault: DatabaseSync,
  journal: DatabaseSync
): AtlasCensusPayload {
  const vaultBreak = dbSizeBreakdown(vault);
  const journalBreak = dbSizeBreakdown(journal);
  const bytesOf = new Map<string, { bytes?: number; pages?: number }>();
  for (const t of vaultBreak.tables)
    bytesOf.set(t.table, { bytes: t.bytes, pages: t.pages });
  for (const t of journalBreak.tables)
    bytesOf.set(t.table, { bytes: t.bytes, pages: t.pages });
  // A single method label for the payload: `estimate` if EITHER file fell back
  // (bytes are then null everywhere — no faked breakdown).
  const method: TableStatsMethod =
    vaultBreak.method === "dbstat" && journalBreak.method === "dbstat"
      ? "dbstat"
      : "estimate";

  const byPack = new Map<string, AtlasCensusPack>();
  let totalRows = 0;
  let totalBytes: number | null = 0;
  let kinds = 0;
  let populatedKinds = 0;

  for (const entry of atlasTables()) {
    // Grant-plane tables ride the canonical registry (export/replica) but
    // are not COUNTed on Atlas first paint. Their row counts belong with
    // the graph, which is already loaded after first paint; the grant
    // surfaces already answer "how many grants". Two extra COUNT(*) would
    // push the first-paint SQL budget past 140 (#825).
    if (
      entry.logical === "share.grant" ||
      entry.logical === "share.fulfillment"
    ) {
      continue;
    }
    const db = entry.file === "vault" ? vault : journal;
    const rows = countRows(db, entry.physical);
    const size = method === "dbstat" ? bytesOf.get(entry.physical) : undefined;
    const bytes = size?.bytes ?? null;
    const pages = size?.pages ?? null;

    const table: AtlasCensusTable = {
      logical: entry.logical,
      physical: entry.physical,
      table: entry.table,
      label: entry.label,
      rows,
      bytes,
      pages,
    };

    const key = `${entry.file}:${entry.pack}`;
    let pack = byPack.get(key);
    if (!pack) {
      pack = {
        pack: entry.pack,
        packLabel: entry.packLabel,
        packKind: entry.packKind,
        file: entry.file,
        tables: [],
        rows: 0,
        bytes: method === "dbstat" ? 0 : null,
      };
      byPack.set(key, pack);
    }
    pack.tables.push(table);
    pack.rows += rows;
    if (pack.bytes !== null && bytes !== null) pack.bytes += bytes;

    totalRows += rows;
    if (totalBytes !== null && bytes !== null) totalBytes += bytes;
    if (entry.packKind === "ontology") {
      kinds += 1;
      if (rows > 0) populatedKinds += 1;
    }
  }
  if (method === "estimate") totalBytes = null;

  const packs = [...byPack.values()].sort((a, b) => {
    // Ontology packs first (life data before plumbing), then by row count.
    if (a.packKind !== b.packKind) return a.packKind === "ontology" ? -1 : 1;
    return b.rows - a.rows;
  });

  return {
    generatedAt: new Date().toISOString(),
    method,
    fileBytesTotal: vaultBreak.fileBytesTotal + journalBreak.fileBytesTotal,
    packs,
    totals: { rows: totalRows, bytes: totalBytes, kinds, populatedKinds },
  };
}
