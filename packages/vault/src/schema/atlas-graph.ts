import type { DatabaseSync } from "node:sqlite";

import { atlasTables } from "./atlas.js";
import type { AtlasPackKind, AtlasTableEntry } from "./atlas.js";
import { resolveEntity } from "./tables.js";

export function countRows(db: DatabaseSync, physical: string): number {
  try {
    const row = db.prepare(`SELECT COUNT(*) AS n FROM "${physical}"`).get() as {
      n: number;
    };
    return row.n;
  } catch {
    return 0;
  }
}

const COUNT_BATCH = 200;

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function sqlIdent(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

export function countRowsBatched(
  db: DatabaseSync,
  physicals: readonly string[]
): Map<string, number> {
  const counts = new Map<string, number>();
  const wanted = [...new Set(physicals)];
  for (const name of wanted) counts.set(name, 0);
  if (wanted.length === 0) return counts;
  const present = new Set(
    (
      db
        .prepare(
          `SELECT name FROM sqlite_master WHERE type IN ('table','view')`
        )
        .all() as unknown as { name: string }[]
    ).map((row) => row.name)
  );
  const existing = wanted.filter((name) => present.has(name));
  for (let start = 0; start < existing.length; start += COUNT_BATCH) {
    const batch = existing.slice(start, start + COUNT_BATCH);
    const sql = batch
      .map(
        (name) =>
          `SELECT ${sqlString(name)} AS t, COUNT(*) AS n FROM ${sqlIdent(name)}`
      )
      .join(" UNION ALL ");
    try {
      const rows = db.prepare(sql).all() as unknown as {
        t: string;
        n: number;
      }[];
      for (const row of rows) counts.set(row.t, row.n);
    } catch {
      for (const name of batch) counts.set(name, countRows(db, name));
    }
  }
  return counts;
}

export const ATLAS_GRAPH_CENTER = "core_party";

export interface AtlasFkEdge {
  fromTable: string;
  fromLogical: string;
  fromPack: string;
  col: string;
  toTable: string;
  toLogical: string | null;
  toPack: string | null;
  notnull: boolean;
  childRows: number;
  fill: number;
  ghost: boolean;
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
  friendly?: string;
  blurb?: string;
  hopDistance: number | null;
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
  fkEdges: AtlasFkEdge[];
  authoredLinks: AtlasAuthoredLink[];
  island: string[];
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
  const cols = vault
    .prepare(`PRAGMA table_info("${physical}")`)
    .all() as unknown as TableInfoRow[];
  return new Set(cols.filter((c) => c.notnull === 1).map((c) => c.name));
}

export function atlasGraph(vault: DatabaseSync): AtlasGraphPayload {
  const vaultEntries = atlasTables();
  const byPhysical = new Map<string, AtlasTableEntry>(
    vaultEntries.map((e) => [e.physical, e])
  );

  const fkEdges: AtlasFkEdge[] = [];
  const selfRefTables = new Set<string>();
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
      if (!byPhysical.has(fk.table)) continue;
      const isNotNull = notNull.has(fk.from);
      // fill: NOT NULL columns are fully filled by definition (== child
      // rowcount); nullable columns need the COUNT WHERE ... IS NOT NULL.
      const fill = isNotNull
        ? childRows
        : (
            vault
              .prepare(
                `SELECT COUNT(*) AS n FROM "${entry.physical}" WHERE "${fk.from}" IS NOT NULL`
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

  // Directed BFS from core_party for ring placement (#441 B2 — rings by
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
    // `friendly` always emitted (curated name, else the humanized label);
    // `blurb` only when the kind is curated — never fabricated.
    friendly: entry.friendly,
    ...(entry.blurb === undefined ? {} : { blurb: entry.blurb }),
    hopDistance: hop.has(entry.physical) ? hop.get(entry.physical)! : null,
    selfRef: selfRefTables.has(entry.physical),
  }));
  const island = nodes
    .filter((n) => n.hopDistance === null)
    .map((n) => n.physical);

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
          ORDER BY count DESC`
      )
      .all() as unknown as AtlasAuthoredLink[]
  ).map((r) => ({ ...r, relationLabel: r.relationLabel ?? null }));

  const centerEdgeCount = fkEdges.filter(
    (e) => e.toTable === ATLAS_GRAPH_CENTER
  ).length;
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

// ───────────────────────────────────────────────────────────────────────────
// Pulse (GET /_vault/atlas/pulse)
// ───────────────────────────────────────────────────────────────────────────

export const ATLAS_PULSE_WINDOW_DAYS = 30;

export interface AtlasPulseDay {
  day: string;
  count: number;
}

export interface AtlasPulseSeries {
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
   * moved to `audit_archive_manifest` segments (#367) and are NOT counted
   * here — a 30-day window rarely reaches the archival horizon, but the flag
   * lets the UI say "live audit band only" honestly.
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
 * 30-day per-table write pulse (#441 B1 sparklines / B4 item 4),
 * derived from the audit band's `access_provenance`, grouped by
 * entity_type × day.
 */
export function atlasPulse(
  vault: DatabaseSync,
  options: { windowDays?: number; now?: Date } = {}
): AtlasPulsePayload {
  const windowDays = options.windowDays ?? ATLAS_PULSE_WINDOW_DAYS;
  const now = options.now ?? new Date();
  const cutoff = new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000);
  const since = cutoff.toISOString().slice(0, 10);

  const rows = vault
    .prepare(
      `SELECT entity_type            AS entityType,
              substr(occurred_at, 1, 10) AS day,
              COUNT(*)               AS count
         FROM access_provenance
        WHERE occurred_at >= ?
        GROUP BY entity_type, day
        ORDER BY entity_type, day`
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
