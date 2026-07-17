// The Vault Atlas census/graph/pulse computations (issue #441 Part B, B4
// items 2-4). These are the read-only payload builders the gateway's
// `/_vault/atlas/*` routes wrap. Kept in the vault package (not the gateway)
// so the ghost-semantics invariant can be tested directly against a migrated
// `:memory:` vault, and so the pack mapping and `table-stats.ts` sit next to
// their single caller.
//
// FK ≠ core_link is the load-bearing distinction (issue #441 "the trap this
// design must not fall into"). Two DIFFERENT relation mechanisms travel as
// SEPARATE collections in the graph payload and must never be conflated:
//   - fkEdges     — schema-enforced FK columns; an edge "carries" when child
//                   rows populate the column (fill = COUNT WHERE col NOT NULL).
//                   A ghost is fill === 0, NEVER "no core_link on this pair".
//   - authoredLinks — user/agent-authored `core_link` rows, typed by a SKOS
//                   concept, free to join any two kinds.

import type { DatabaseSync } from 'node:sqlite';
import { dbSizeBreakdown, type TableStatsMethod } from './table-stats.js';
import { resolveEntity } from './tables.js';
import { atlasTables, type AtlasPackKind, type AtlasTableEntry } from './atlas.js';

// ---------------------------------------------------------------------------
// Census (GET /_vault/atlas/stats)
// ---------------------------------------------------------------------------

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
  file: 'vault' | 'journal';
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

function countRows(db: DatabaseSync, physical: string): number {
  try {
    const row = db.prepare(`SELECT COUNT(*) AS n FROM "${physical}"`).get() as { n: number };
    return row.n;
  } catch {
    // A table the registry lists but this file doesn't carry (schema skew) —
    // report zero rather than fail the whole census.
    return 0;
  }
}

/**
 * Grouped census of the vault (issue #441 B1): per-table rows/bytes wrapped
 * with the pack mapping. Bytes come from `table-stats.ts` (dbstat, with its
 * documented `estimate` fallback); rows are a COUNT(*) per table (the dbstat
 * method omits rows by design, and the census header wants "214 people").
 */
export function atlasCensus(vault: DatabaseSync, journal: DatabaseSync): AtlasCensusPayload {
  const vaultBreak = dbSizeBreakdown(vault);
  const journalBreak = dbSizeBreakdown(journal);
  const bytesOf = new Map<string, { bytes?: number; pages?: number }>();
  for (const t of vaultBreak.tables) bytesOf.set(t.table, { bytes: t.bytes, pages: t.pages });
  for (const t of journalBreak.tables) bytesOf.set(t.table, { bytes: t.bytes, pages: t.pages });
  // A single method label for the payload: `estimate` if EITHER file fell back
  // (bytes are then null everywhere — no faked breakdown).
  const method: TableStatsMethod =
    vaultBreak.method === 'dbstat' && journalBreak.method === 'dbstat' ? 'dbstat' : 'estimate';

  const byPack = new Map<string, AtlasCensusPack>();
  let totalRows = 0;
  let totalBytes: number | null = 0;
  let kinds = 0;
  let populatedKinds = 0;

  for (const entry of atlasTables()) {
    const db = entry.file === 'vault' ? vault : journal;
    const rows = countRows(db, entry.physical);
    const size = method === 'dbstat' ? bytesOf.get(entry.physical) : undefined;
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
        bytes: method === 'dbstat' ? 0 : null,
      };
      byPack.set(key, pack);
    }
    pack.tables.push(table);
    pack.rows += rows;
    if (pack.bytes !== null && bytes !== null) pack.bytes += bytes;

    totalRows += rows;
    if (totalBytes !== null && bytes !== null) totalBytes += bytes;
    if (entry.packKind === 'ontology') {
      kinds += 1;
      if (rows > 0) populatedKinds += 1;
    }
  }
  if (method === 'estimate') totalBytes = null;

  const packs = [...byPack.values()].sort((a, b) => {
    // Ontology packs first (life data before plumbing), then by row count.
    if (a.packKind !== b.packKind) return a.packKind === 'ontology' ? -1 : 1;
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

// ---------------------------------------------------------------------------
// Graph (GET /_vault/atlas/graph)
// ---------------------------------------------------------------------------

/** The kind at the centre of the orrery — the data says so (46/122 → core_party). */
export const ATLAS_GRAPH_CENTER = 'core_party';

export interface AtlasFkEdge {
  /** Child (referencing) table. */
  fromTable: string;
  fromLogical: string;
  fromPack: string;
  /** The FK column on the child. */
  col: string;
  /** Parent (referenced) table. */
  toTable: string;
  toLogical: string | null;
  toPack: string | null;
  /** The child column is NOT NULL (⇒ fill == child rowcount, never a ghost). */
  notnull: boolean;
  /** Child table's total rowcount. */
  childRows: number;
  /** COUNT(*) WHERE col IS NOT NULL on the child — the edge's "fill". */
  fill: number;
  /** fill === 0 — the honest ghost test (empty child, or an unset column). */
  ghost: boolean;
  /** Child references itself — a hierarchy, drawn as a tree not a loop. */
  selfRef: boolean;
}

export interface AtlasGraphNode {
  physical: string;
  logical: string;
  table: string;
  label: string;
  pack: string;
  packKind: AtlasPackKind;
  packLabel: string;
  /** Undirected hop distance from `core_party`; null = unreached island. */
  hopDistance: number | null;
  /** This table has a self-referencing FK. */
  selfRef: boolean;
}

export interface AtlasAuthoredLink {
  relationConceptId: string;
  relationLabel: string | null;
  fromType: string;
  toType: string;
  count: number;
}

export interface AtlasGraphPayload {
  generatedAt: string;
  center: string;
  nodes: AtlasGraphNode[];
  /** Schema-enforced FK edges — SEPARATE from authored links (FK ≠ core_link). */
  fkEdges: AtlasFkEdge[];
  /** Authored `core_link` rows, aggregated by (relation, from_type, to_type). */
  authoredLinks: AtlasAuthoredLink[];
  /** Physical tables unreached from core_party over the FK graph. */
  island: string[];
  /** Derived edge tallies (NEVER hardcode 122/46 — computed here). */
  edgeCount: number;
  centerEdgeCount: number;
  selfRefCount: number;
}

interface ForeignKeyRow {
  id: number;
  seq: number;
  table: string;
  from: string;
  to: string;
}

interface TableInfoRow {
  name: string;
  notnull: number;
}

function notNullColumns(vault: DatabaseSync, physical: string): Set<string> {
  const cols = vault.prepare(`PRAGMA table_info("${physical}")`).all() as unknown as TableInfoRow[];
  return new Set(cols.filter((c) => c.notnull === 1).map((c) => c.name));
}

/**
 * The FK graph + authored-link overlay (issue #441 B2). Walks
 * `PRAGMA foreign_key_list` for every registered vault-file table, computes
 * each edge's fill on request (an owner ops screen — no cache), runs a BFS
 * for ring placement, and aggregates `core_link` SEPARATELY. Nothing here is
 * hand-listed; the "star not mesh" caption numbers are all derived.
 */
export function atlasGraph(vault: DatabaseSync): AtlasGraphPayload {
  // Vault-file tables only — the FK graph is one file (journal FKs are
  // cross-file and gateway-enforced, invisible to PRAGMA anyway).
  const vaultEntries = atlasTables().filter((e) => e.file === 'vault');
  const byPhysical = new Map<string, AtlasTableEntry>(vaultEntries.map((e) => [e.physical, e]));

  const fkEdges: AtlasFkEdge[] = [];
  const selfRefTables = new Set<string>();
  // Ring adjacency is DIRECTED parent → child (referenced → referencing): the
  // orrery centres core_party and places its referencers on ring 1, THEIR
  // referencers on ring 2, and so on. An FK column points child → parent, so
  // we walk it in reverse for hop distance. This is what makes the locker +
  // sync cluster an honest island — sync_connection references nothing
  // reachable from core_party, so nothing reaches it, and locker_item (which
  // references sync_connection) hangs off it. An UNDIRECTED walk would falsely
  // bridge the island through any table that references both sides.
  const childrenOf = new Map<string, Set<string>>();
  for (const entry of vaultEntries) childrenOf.set(entry.physical, new Set());
  const addChild = (parent: string, child: string): void => {
    if (!childrenOf.has(parent)) childrenOf.set(parent, new Set());
    childrenOf.get(parent)!.add(child);
  };

  for (const entry of vaultEntries) {
    const fks = vault
      .prepare(`PRAGMA foreign_key_list("${entry.physical}")`)
      .all() as unknown as ForeignKeyRow[];
    if (fks.length === 0) continue;
    const notNull = notNullColumns(vault, entry.physical);
    const childRows = countRows(vault, entry.physical);
    for (const fk of fks) {
      const isNotNull = notNull.has(fk.from);
      // fill: NOT NULL columns are fully filled by definition (== child
      // rowcount); nullable columns need the COUNT WHERE ... IS NOT NULL.
      const fill = isNotNull
        ? childRows
        : (
            vault
              .prepare(
                `SELECT COUNT(*) AS n FROM "${entry.physical}" WHERE "${fk.from}" IS NOT NULL`,
              )
              .get() as { n: number }
          ).n;
      const selfRef = fk.table === entry.physical;
      if (selfRef) selfRefTables.add(entry.physical);
      const target = byPhysical.get(fk.table);
      fkEdges.push({
        fromTable: entry.physical,
        fromLogical: entry.logical,
        fromPack: entry.pack,
        col: fk.from,
        toTable: fk.table,
        toLogical: target?.logical ?? null,
        toPack: target?.pack ?? null,
        notnull: isNotNull,
        childRows,
        fill,
        ghost: fill === 0,
        selfRef,
      });
      if (!selfRef) addChild(fk.table, entry.physical);
    }
  }

  // Directed BFS from core_party for ring placement (issue #441 B2 — rings by
  // hop distance, unreached tables on the island ring).
  const hop = new Map<string, number>();
  if (childrenOf.has(ATLAS_GRAPH_CENTER)) {
    hop.set(ATLAS_GRAPH_CENTER, 0);
    let frontier = [ATLAS_GRAPH_CENTER];
    let dist = 0;
    while (frontier.length > 0) {
      dist += 1;
      const next: string[] = [];
      for (const node of frontier) {
        for (const child of childrenOf.get(node) ?? []) {
          if (!hop.has(child)) {
            hop.set(child, dist);
            next.push(child);
          }
        }
      }
      frontier = next;
    }
  }

  const nodes: AtlasGraphNode[] = vaultEntries.map((entry) => ({
    physical: entry.physical,
    logical: entry.logical,
    table: entry.table,
    label: entry.label,
    pack: entry.pack,
    packKind: entry.packKind,
    packLabel: entry.packLabel,
    hopDistance: hop.has(entry.physical) ? hop.get(entry.physical)! : null,
    selfRef: selfRefTables.has(entry.physical),
  }));
  const island = nodes.filter((n) => n.hopDistance === null).map((n) => n.physical);

  // Authored links (core_link) — SEPARATE from FK edges. Live links only
  // (valid_to IS NULL); a temporal end-date retires a relation. Concept
  // labels joined for the relation-vocabulary chips.
  const authoredLinks = (
    vault
      .prepare(
        `SELECT l.relation_concept_id AS relationConceptId,
                c.pref_label          AS relationLabel,
                l.from_type           AS fromType,
                l.to_type             AS toType,
                COUNT(*)              AS count
           FROM core_link l
           LEFT JOIN core_concept c ON c.concept_id = l.relation_concept_id
          WHERE l.valid_to IS NULL
          GROUP BY l.relation_concept_id, l.from_type, l.to_type
          ORDER BY count DESC`,
      )
      .all() as unknown as AtlasAuthoredLink[]
  ).map((r) => ({ ...r, relationLabel: r.relationLabel ?? null }));

  const centerEdgeCount = fkEdges.filter((e) => e.toTable === ATLAS_GRAPH_CENTER).length;
  return {
    generatedAt: new Date().toISOString(),
    center: ATLAS_GRAPH_CENTER,
    nodes,
    fkEdges,
    authoredLinks,
    island,
    edgeCount: fkEdges.length,
    centerEdgeCount,
    selfRefCount: selfRefTables.size,
  };
}

// ---------------------------------------------------------------------------
// Pulse (GET /_vault/atlas/pulse)
// ---------------------------------------------------------------------------

export const ATLAS_PULSE_WINDOW_DAYS = 30;

export interface AtlasPulseDay {
  day: string;
  count: number;
}

export interface AtlasPulseSeries {
  /** The entity type as stored in consent_provenance (logical `schema.table`). */
  entityType: string;
  /** Physical name when the entity type resolves to a registered table. */
  physical: string | null;
  pack: string | null;
  label: string | null;
  total: number;
  /** Sparse per-day counts within the window (only days with writes). */
  days: AtlasPulseDay[];
}

export interface AtlasPulsePayload {
  generatedAt: string;
  /** Inclusive cutoff — the first day of the window (YYYY-MM-DD). */
  since: string;
  windowDays: number;
  /**
   * The pulse queries only LIVE provenance rows. Old rows may have been
   * moved to `journal_archive_manifest` segments (issue #367 §E) and are NOT
   * counted here — a 30-day window rarely reaches the archival horizon, but
   * the flag lets the UI say "live journal only" honestly.
   */
  live: true;
  series: AtlasPulseSeries[];
}

interface PulseRow {
  entityType: string;
  day: string;
  count: number;
}

/**
 * 30-day per-table write pulse (issue #441 B1 sparklines / B4 item 4),
 * derived from journal.db `consent_provenance` grouped by entity_type × day.
 */
export function atlasPulse(
  journal: DatabaseSync,
  options: { windowDays?: number; now?: Date } = {},
): AtlasPulsePayload {
  const windowDays = options.windowDays ?? ATLAS_PULSE_WINDOW_DAYS;
  const now = options.now ?? new Date();
  const cutoff = new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000);
  const since = cutoff.toISOString().slice(0, 10);

  const rows = journal
    .prepare(
      `SELECT entity_type            AS entityType,
              substr(occurred_at, 1, 10) AS day,
              COUNT(*)               AS count
         FROM consent_provenance
        WHERE occurred_at >= ?
        GROUP BY entity_type, day
        ORDER BY entity_type, day`,
    )
    .all(cutoff.toISOString()) as unknown as PulseRow[];

  const byEntity = new Map<string, AtlasPulseSeries>();
  for (const row of rows) {
    let series = byEntity.get(row.entityType);
    if (!series) {
      const ref = resolveEntity(row.entityType);
      series = {
        entityType: row.entityType,
        physical: ref?.physical ?? null,
        pack: ref?.schema ?? null,
        label: ref?.table ?? null,
        total: 0,
        days: [],
      };
      byEntity.set(row.entityType, series);
    }
    series.days.push({ day: row.day, count: row.count });
    series.total += row.count;
  }

  return {
    generatedAt: now.toISOString(),
    since,
    windowDays,
    live: true,
    series: [...byEntity.values()].sort((a, b) => b.total - a.total),
  };
}
