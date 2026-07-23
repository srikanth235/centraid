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
  /** The dial — per-pack sector arcs + boundary ticks on the outer bezel. */
  dialR: 278,
  dialTickIn: 272,
  dialTickOut: 284,
  sectorLabelR: 292,
} as const;

/**
 * The camera through which the chart body is viewed: a `translate(x y) scale(k)`
 * applied to a single viewport `<g>` that wraps every layer. This is a CAMERA,
 * not a layout change — pan/zoom never touch bearings, radii, hop rings or edge
 * paths (all of which stay computed in the fixed 0..`view` viewBox space). The
 * invariant the whole feature protects: `view` moves the lens, geometry stays
 * put, so re-centring maths and the anti-hairball compass are wholly unaffected.
 */
export interface ViewTransform {
  x: number;
  y: number;
  k: number;
}

/** Zoom bounds. Below `ZOOM_MIN` the chart would rattle inside its well; above
 *  `ZOOM_MAX` the vector art has no more detail to reveal. */
export const ZOOM_MIN = 0.55;
export const ZOOM_MAX = 4;

/** Identity camera — the framed, un-panned default a fresh centre lands on. */
export const IDENTITY_VIEW: ViewTransform = { x: 0, y: 0, k: 1 };

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));

/**
 * Zoom about a fixed point `(px, py)` given in the OUTER viewBox coordinate
 * space (i.e. the value `clientToViewBox` returns — where the cursor sits on
 * the un-transformed canvas). The screen position of that point is held still
 * while `k` scales by `factor`: with `k2 = clamp(k·factor)` and `f = k2/k`,
 * `x' = px − f·(px − x)` keeps `px = x + k·q` mapping to the same `px` after the
 * scale. Clamps at the zoom bounds, so pushing past a bound is a no-op (the
 * fixed point still holds because `f` is then 1).
 */
export function zoomView(
  view: ViewTransform,
  px: number,
  py: number,
  factor: number,
  minK: number,
  maxK: number,
): ViewTransform {
  const k2 = clamp(view.k * factor, minK, maxK);
  const f = k2 / view.k;
  return {
    x: px - f * (px - view.x),
    y: py - f * (py - view.y),
    k: k2,
  };
}

/** Pan the camera by a delta already expressed in viewBox units (the caller
 *  converts client pixels → viewBox units via the svg's on-screen size). Pure
 *  translation; `k` is untouched. */
export function panView(view: ViewTransform, dx: number, dy: number): ViewTransform {
  return { x: view.x + dx, y: view.y + dy, k: view.k };
}

/**
 * Map a pointer's client coordinates to the square viewBox coordinate space,
 * using the svg's on-screen bounding rect. Deliberately avoids
 * `getScreenCTM`/`createSVGPoint` (both absent under jsdom); the viewBox is a
 * square of side `viewSize` drawn to fill `rect`, so the mapping is a simple
 * ratio. Returns `null` on a degenerate (zero-size) rect — which is exactly
 * what jsdom reports — so callers fall back to zooming about the canvas centre.
 */
export function clientToViewBox(
  rect: { left: number; top: number; width: number; height: number },
  viewSize: number,
  clientX: number,
  clientY: number,
): { x: number; y: number } | null {
  if (rect.width <= 0 || rect.height <= 0) return null;
  return {
    x: ((clientX - rect.left) / rect.width) * viewSize,
    y: ((clientY - rect.top) / rect.height) * viewSize,
  };
}

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
  /** physical table name → label stagger tier. Adjacent kinds within a pack
   *  alternate 0/1 so their rotated labels sit at two radial distances and
   *  stop colliding in dense sectors. Purely cosmetic, bearing-stable. */
  labelTier: Map<string, 0 | 1>;
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
  const labelTier = new Map<string, 0 | 1>();
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
      labelTier.set(n.physical, (i % 2) as 0 | 1);
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
  return { bearing, labelTier, sectors };
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

// ── The detail dial: Simple / Standard / Everything ─────────────────────────
//
// The dial is a three-position FILTER over the chart, never an aggregation. It
// only ever changes WHICH of the real kinds and real edges are visible — it
// never synthesizes a fake node or a fake edge, and it never collapses several
// kinds into one. Turning the dial is therefore always an honest lens: every
// dot it shows is a real table, and everything it hides is spelled out in the
// caption tally.
//
// Two invariants the predicates below protect, deliberately kept pure so tests
// can pin them directly:
//   1. Bearings stay fixed. Bearing allocation runs ONCE over the full node set
//      (see `allocateBearings`), so a kind's compass direction never changes
//      when you turn the dial — kinds simply appear or disappear at their fixed
//      bearings. The dial never re-shuffles the compass (the anti-hairball
//      invariant this whole module exists to protect).
//   2. Distance is a property of the schema, not the lens. Hop/BFS is computed
//      over the FULL edge set regardless of the dial level, so a Simple-visible
//      kind whose FK path runs through a hidden kind keeps its true ring.

/** The three detail-dial positions, from the tightest "your data" lens to the
 *  full "every table the schema declares" lens. */
export type AtlasDetailLevel = 'simple' | 'standard' | 'everything';

/**
 * Whether a kind PROVABLY carries data — the Simple lens's admission test. A
 * kind qualifies when either (a) its own row count is a known positive number,
 * or (b) any FK edge incident to it (in either direction) actually carries rows
 * (`fill > 0`). An UNKNOWN row count (a table that is only ever an FK target, so
 * `rowsByTable` has no entry for it) is treated exactly like zero: it is not by
 * itself proof of data, and the kind shows at Simple only if a live edge lands
 * on it. Ghost edges (`fill === 0`) never count — they are precisely the "no row
 * uses this yet" signal.
 *
 * Truth table (row count vs. an incident live edge with `fill > 0`):
 *   rows > 0                → true   (own rows are proof enough)
 *   rows === 0 + live edge  → true   (empty table, but data flows across it)
 *   rows === 0 + no live    → false  (genuinely empty)
 *   rows unknown + live     → true   (target-only kind that live edges reach)
 *   rows unknown + no live  → false  (no positive evidence of any data)
 */
export function kindCarriesData(
  physical: string,
  rows: ReadonlyMap<string, number>,
  edges: readonly AtlasFkEdge[],
): boolean {
  const own = rows.get(physical);
  if (own !== undefined && own > 0) return true;
  return edges.some((e) => (e.fromTable === physical || e.toTable === physical) && e.fill > 0);
}

/** The inputs a level predicate reads about the current frame. `hops` and
 *  `rows`/`edges` are all computed over the FULL graph (never re-derived per
 *  level), so distance and data-provenance are lens-independent facts. */
export interface VisibilityContext {
  center: string;
  hops: ReadonlyMap<string, number | null>;
  rows: ReadonlyMap<string, number>;
  edges: readonly AtlasFkEdge[];
}

/**
 * Whether `node` is visible at the given dial level. This is a FILTER over real
 * kinds — it never invents one, and (crucially) it never hides the current
 * centre: a re-centre onto any kind, e.g. via a breadcrumb, keeps that kind on
 * the brass plate even when the active level would otherwise filter it out.
 *
 * Per level (the centre short-circuit above wins first at every level):
 *   simple      — only kinds that PROVABLY carry data (`kindCarriesData`), and
 *                 never machinery (plumbing is hidden even when reachable). The
 *                 "your data" lens.
 *   standard    — today's lens: ontology always; machinery only when reachable
 *                 from the centre (a finite hop distance).
 *   everything  — every table the schema declares, including the unreachable
 *                 machinery on the island that standard filters out.
 */
export function visibleAtLevel(
  level: AtlasDetailLevel,
  node: AtlasGraphNode,
  ctx: VisibilityContext,
): boolean {
  if (node.physical === ctx.center) return true; // the dial never hides the centre
  if (level === 'everything') return true;
  if (level === 'simple') {
    if (node.packKind === 'machinery') return false; // plumbing, hidden at Simple
    return kindCarriesData(node.physical, ctx.rows, ctx.edges);
  }
  // standard — ontology always; machinery only when reachable from the centre
  if (node.packKind === 'ontology') return true;
  return ctx.hops.get(node.physical) != null;
}

/**
 * Whether an FK edge should be drawn at the given level. Both endpoints must be
 * VISIBLE (an edge into a hidden kind would streak into empty space) and the
 * edge can't be a self-reference (drawn as a glyph on the node, never a loop).
 * At Simple, ghost edges (nothing fills them yet) are additionally hidden — the
 * "your data" lens shows only connections real rows travel. `visible` must be
 * the set of visible physical names WITH the centre included.
 */
export function edgeVisibleAtLevel(
  level: AtlasDetailLevel,
  edge: AtlasFkEdge,
  visible: ReadonlySet<string>,
): boolean {
  if (edge.selfRef) return false;
  if (level === 'simple' && edge.ghost) return false;
  return visible.has(edge.fromTable) && visible.has(edge.toTable);
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
 * Bow factor for an edge between two bearings. Spokes into/out of the core are
 * handled by the caller (bow 1 = straight radial); for everything else the bow
 * deepens with angular separation. Two neighbours on the same ring get a
 * near-straight chord — a fixed bow there folds the short chord into a hairpin
 * loop (the "scribble" artifact the sync island used to draw); two kinds on
 * opposite sides arc well clear of the plate.
 */
export function edgeBow(fromDeg: number, toDeg: number): number {
  let sep = Math.abs(fromDeg - toDeg) % 360;
  if (sep > 180) sep = 360 - sep;
  return Number((1 - 0.24 * (sep / 180)).toFixed(3));
}

/**
 * Quadratic-bezier path between two points, bowed toward the centre by `bow`
 * (1 = straight radial spoke, <1 = orbital arc). Spokes into/out of the core
 * stay radial (they carry the 38% that converge on core_party); everything else
 * bows so arcs never cross the plate.
 */
export function edgePath(ax: number, ay: number, bx: number, by: number, bow: number): string {
  const mx = (ax + bx) / 2;
  const my = (ay + by) / 2;
  const qx = ORRERY.cx + (mx - ORRERY.cx) * bow;
  const qy = ORRERY.cy + (my - ORRERY.cy) * bow;
  return `M ${r1(ax)} ${r1(ay)} Q ${r1(qx)} ${r1(qy)} ${r1(bx)} ${r1(by)}`;
}

/**
 * Circular-arc path along radius `r` from bearing `a1` to `a2` (degrees,
 * clockwise). With `flip`, the arc runs `a2`→`a1` counterclockwise instead —
 * a `<textPath>` laid on the flipped arc reads upright in the bottom half of
 * the dial rather than upside-down. Angular spans stay under 180° here (pack
 * sectors), so the large-arc flag only trips for a hypothetical single-pack
 * vault.
 */
export function dialArcPath(a1: number, a2: number, r: number, flip: boolean): string {
  const s = polar(flip ? a2 : a1, r);
  const e = polar(flip ? a1 : a2, r);
  const large = Math.abs(a2 - a1) > 180 ? 1 : 0;
  const sweep = flip ? 0 : 1;
  return `M ${r1(s.x)} ${r1(s.y)} A ${r1(r)} ${r1(r)} 0 ${large} ${sweep} ${r1(e.x)} ${r1(e.y)}`;
}

/** Whether a dial label at this mid-bearing would read upside-down without
 *  flipping — true for the bottom half of the dial (SVG y grows downward). */
export function sectorFlipped(midDeg: number): boolean {
  const m = ((midDeg % 360) + 360) % 360;
  return m > 0 && m < 180;
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
