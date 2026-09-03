import type { DatabaseSync } from "node:sqlite";

import { countRowsBatched } from "./atlas-graph.js";
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

export interface AtlasCensusTable {
  logical: string;
  physical: string;
  table: string;
  label: string;
  rows: number;
  bytes: number | null;
  pages: number | null;
}

export interface AtlasCensusPack {
  pack: string;
  packLabel: string;
  packKind: AtlasPackKind;
  tables: AtlasCensusTable[];
  rows: number;
  bytes: number | null;
}

export interface AtlasCensusPayload {
  generatedAt: string;
  method: TableStatsMethod;
  fileBytesTotal: number;
  packs: AtlasCensusPack[];
  totals: {
    rows: number;
    bytes: number | null;
    kinds: number;
    populatedKinds: number;
  };
}

export function atlasCensus(vault: DatabaseSync): AtlasCensusPayload {
  const vaultBreak = dbSizeBreakdown(vault);
  const bytesOf = new Map<string, { bytes?: number; pages?: number }>();
  for (const t of vaultBreak.tables)
    bytesOf.set(t.table, { bytes: t.bytes, pages: t.pages });
  const method: TableStatsMethod = vaultBreak.method;

  const byPack = new Map<string, AtlasCensusPack>();
  let totalRows = 0;
  let totalBytes: number | null = 0;
  let kinds = 0;
  let populatedKinds = 0;

  const entries = atlasTables();
  const counts = countRowsBatched(
    vault,
    entries.map((e) => e.physical)
  );

  for (const entry of entries) {
    const rows = counts.get(entry.physical) ?? 0;
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

    const key = entry.pack;
    let pack = byPack.get(key);
    if (!pack) {
      pack = {
        pack: entry.pack,
        packLabel: entry.packLabel,
        packKind: entry.packKind,
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
    if (a.packKind !== b.packKind) return a.packKind === "ontology" ? -1 : 1;
    return b.rows - a.rows;
  });

  return {
    generatedAt: new Date().toISOString(),
    method,
    fileBytesTotal: vaultBreak.fileBytesTotal,
    packs,
    totals: { rows: totalRows, bytes: totalBytes, kinds, populatedKinds },
  };
}
