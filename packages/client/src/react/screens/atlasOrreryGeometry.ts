// Pure, deterministic geometry for the Relations orrery (issue #441 B2). Kept
// out of the component so tests can hit the maths directly — bearing
// allocation, hop BFS, ring radius, fill→width mapping and edge paths are all
// side-effect-free functions of their inputs. The one invariant everything here
// protects: a kind's BEARING is a stable compass direction that never changes
// when you re-centre; only its RADIUS moves. That is what keeps the chart from
// degenerating into a 46-legged force-directed hairball.

import type { AtlasAuthoredLink, AtlasFkEdge, AtlasGraphNode } from '../../gateway-client.js';

/** Fixed canvas — a square viewBox centred on core_party's brass plate. */
export const ORRERY = {
  cx: 310,
  cy: 310,
  view: 620,
  coreR: 34,
  ringHop1: 112,
  ringHop2: 172,
  ringHop3: 222,
  ringUnreached: 264,
  sectorLabelR: 292,
} as const;

/** The 8 app-icon palette hues (`--c-*` tokens), used as stable pack bearings'
 *  colour. Packs are hue-assigned by their position in the sorted pack list so
 *  the mapping is deterministic and theme-driven (never a hardcoded hex). */
export const PALETTE_HUES = [
  'amber',
  'forest',
  'indigo',
  'ochre',
  'rose',
  'slate',
  'teal',
  'violet',
] as const;

/** The distinct pack names present, stably sorted — the canonical pack order
 *  used for both bearing sectors and hue assignment. */
export function sortedPacks(nodes: readonly AtlasGraphNode[]): string[] {
  return [...new Set(nodes.map((n) => n.pack))].sort();
}

/** The `--c-*` token a pack paints with, by its slot in the sorted pack list. */
export function packHueVar(pack: string, packs: readonly string[]): string {
  const idx = packs.indexOf(pack);
  const hue = PALETTE_HUES[(idx < 0 ? 0 : idx) % PALETTE_HUES.length];
  return `var(--c-${hue})`;
}

export interface PackSector {
  pack: string;
  packLabel: string;
  startDeg: number;
  spanDeg: number;
  midDeg: number;
}

export interface BearingLayout {
  /** physical table name → bearing in degrees (0 = 3 o'clock, clockwise). */
  bearing: Map<string, number>;
  sectors: PackSector[];
}

/**
 * Give every pack a fixed angular sector proportional to its kind count, and
 * spread that pack's kinds evenly inside it. Computed once over the WHOLE node
 * set (never per-centre), so a node's bearing is invariant. Packs are laid out
 * in stable name order starting at 12 o'clock; kinds within a pack in stable
 * physical-name order. This is the anti-hairball invariant.
 */
export function allocateBearings(nodes: readonly AtlasGraphNode[]): BearingLayout {
  const total = nodes.length || 1;
  const byPack = new Map<string, AtlasGraphNode[]>();
  for (const n of nodes) {
    const arr = byPack.get(n.pack);
    if (arr) arr.push(n);
    else byPack.set(n.pack, [n]);
  }
  const packs = [...byPack.keys()].sort();
  const bearing = new Map<string, number>();
  const sectors: PackSector[] = [];
  let a = -90; // 12 o'clock
  for (const pack of packs) {
    const list = byPack
      .get(pack)!
      .slice()
      .sort((x, y) => (x.physical < y.physical ? -1 : x.physical > y.physical ? 1 : 0));
    const span = (360 * list.length) / total;
    const pad = Math.min(2.2, span * 0.14);
    const inner = span - pad * 2;
    list.forEach((n, i) => {
      const b = list.length === 1 ? a + span / 2 : a + pad + (i + 0.5) * (inner / list.length);
      bearing.set(n.physical, b);
    });
    sectors.push({
      pack,
      packLabel: list[0]?.packLabel ?? pack,
      startDeg: a,
      spanDeg: span,
      midDeg: a + span / 2,
    });
    a += span;
  }
  return { bearing, sectors };
}

/**
 * Hop distance from `center` over the FK graph treated as an UNDIRECTED
 * adjacency (self-references excluded — a hierarchy is not a hop). Unreachable
 * tables map to `null`; for the default centre (core_party) that null set
 * equals the payload's `island`, because the locker/sync component is genuinely
 * disconnected (no edge bridges it either direction). Memoize the result per
 * centre in the caller — this walk is O(edges) but re-run on every re-centre.
 */
export function bfsHops(
  center: string,
  edges: readonly AtlasFkEdge[],
  allTables: readonly string[],
): Map<string, number | null> {
  const adj = new Map<string, Set<string>>();
  for (const t of allTables) adj.set(t, new Set());
  for (const e of edges) {
    if (e.selfRef) continue;
    const from = adj.get(e.fromTable);
    const to = adj.get(e.toTable);
    if (!from || !to) continue; // an edge to an unregistered kind — cannot place
    from.add(e.toTable);
    to.add(e.fromTable);
  }
  const dist = new Map<string, number | null>();
  for (const t of allTables) dist.set(t, null);
  if (!adj.has(center)) return dist;
  dist.set(center, 0);
  let frontier = [center];
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const n of frontier) {
      const d = dist.get(n) as number;
      for (const m of adj.get(n) ?? []) {
        if (dist.get(m) === null) {
          dist.set(m, d + 1);
          next.push(m);
        }
      }
    }
    frontier = next;
  }
  return dist;
}

/** The physical tables unreachable from `center` — the "unreached" ring set. */
export function unreachedFrom(
  center: string,
  edges: readonly AtlasFkEdge[],
  allTables: readonly string[],
): string[] {
  const hops = bfsHops(center, edges, allTables);
  return allTables.filter((t) => hops.get(t) === null);
}

/** Radius of the concentric ring a given hop distance sits on. */
export function ringRadius(hop: number | null): number {
  if (hop === null) return ORRERY.ringUnreached;
  if (hop <= 0) return 0; // the centre itself
  if (hop === 1) return ORRERY.ringHop1;
  if (hop === 2) return ORRERY.ringHop2;
  return ORRERY.ringHop3;
}

/** Cartesian point for a bearing (deg) + radius, about the canvas centre. */
export function polar(bearingDeg: number, radius: number): { x: number; y: number } {
  const a = (bearingDeg * Math.PI) / 180;
  return { x: ORRERY.cx + Math.cos(a) * radius, y: ORRERY.cy + Math.sin(a) * radius };
}

/**
 * Stroke width for an edge carrying `fill` child rows, on a log scale against
 * the busiest edge so a 41,230-row spine reads as heavier than a 10-row column
 * without swamping it. Ghost edges (fill 0) get a fixed hairline — they are
 * drawn dotted, not weighted.
 */
export function fillStrokeWidth(fill: number, maxFill: number): number {
  if (fill <= 0) return 0.7;
  const denom = Math.log10(Math.max(maxFill, 1) + 1) || 1;
  const l = Math.log10(fill + 1) / denom; // 0..1
  return Number((0.5 + 5 * l * l).toFixed(2));
}

/** Stroke opacity for a live edge — heavier fills read more solid; nullable
 *  columns sit a touch fainter than their NOT NULL siblings. */
export function fillStrokeOpacity(fill: number, maxFill: number, notnull: boolean): number {
  const denom = Math.log10(Math.max(maxFill, 1) + 1) || 1;
  const l = fill <= 0 ? 0 : Math.log10(fill + 1) / denom;
  const base = 0.3 + 0.45 * l;
  return Number((notnull ? base : base * 0.8).toFixed(2));
}

const r1 = (n: number): string => n.toFixed(1);

/**
 * Quadratic-bezier path between two points, bowed toward the centre by `bow`
 * (1 = straight radial spoke, <1 = orbital arc). Spokes into/out of the core
 * stay radial (they carry the 38% that converge on core_party); everything else
 * bows slightly so arcs never cross the plate.
 */
export function edgePath(ax: number, ay: number, bx: number, by: number, bow: number): string {
  const mx = (ax + bx) / 2;
  const my = (ay + by) / 2;
  const qx = ORRERY.cx + (mx - ORRERY.cx) * bow;
  const qy = ORRERY.cy + (my - ORRERY.cy) * bow;
  return `M ${r1(ax)} ${r1(ay)} Q ${r1(qx)} ${r1(qy)} ${r1(bx)} ${r1(by)}`;
}

/** Node body radius. The graph payload carries no per-node row count, so we
 *  derive it from the child-row count of edges that originate at the node when
 *  available (all edges from one table share its rowcount); target-only kinds
 *  fall back to a neutral radius. Purely cosmetic weight, never a fill claim. */
export function nodeRadius(rows: number | undefined): number {
  if (rows === undefined) return 5;
  if (rows <= 0) return 4;
  return Number(Math.min(11, 3 + 1.1 * rows ** 0.28).toFixed(2));
}

/** Map physical table → its own row count, read off any edge that starts there
 *  (every FK from a table reports that table's `childRows`). */
export function rowsByTable(edges: readonly AtlasFkEdge[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const e of edges) if (!m.has(e.fromTable)) m.set(e.fromTable, e.childRows);
  return m;
}

/** Distinct relation vocabulary, keyed by label (falling back to concept id),
 *  with the total count of authored links carrying that relation. The authored
 *  links (core_link) are a SEPARATE mechanism from structural FKs — this only
 *  tallies the vocabulary, it never conflates the two. */
export interface RelationChip {
  key: string;
  label: string;
  count: number;
}

/** Aggregate authored links into the distinct relation-vocabulary chips,
 *  sorted by descending count. Pure over the payload's `authoredLinks`. */
export function aggregateRelationChips(links: readonly AtlasAuthoredLink[]): RelationChip[] {
  const byKey = new Map<string, RelationChip>();
  for (const link of links) {
    const key = link.relationLabel ?? link.relationConceptId;
    const label = link.relationLabel ?? 'untyped link';
    const existing = byKey.get(key);
    if (existing) existing.count += link.count;
    else byKey.set(key, { key, label, count: link.count });
  }
  return [...byKey.values()].sort((a, b) => b.count - a.count);
}
