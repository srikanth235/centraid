import type {
  AtlasAuthoredLink,
  AtlasFkEdge,
  AtlasGraphNode,
} from "../../gateway-client.js";

export const ORRERY = {
  cx: 310,
  cy: 310,
  view: 620,
  coreR: 34,
  ringHop1: 112,
  ringHop2: 172,
  ringHop3: 222,
  ringUnreached: 264,
  dialR: 278,
  dialTickIn: 272,
  dialTickOut: 284,
  sectorLabelR: 292,
} as const;

export interface ViewTransform {
  x: number;
  y: number;
  k: number;
}

export const ZOOM_MIN = 0.55;
export const ZOOM_MAX = 4;

export const IDENTITY_VIEW: ViewTransform = { x: 0, y: 0, k: 1 };

const clamp = (n: number, lo: number, hi: number): number =>
  Math.min(hi, Math.max(lo, n));

export function zoomView(
  view: ViewTransform,
  px: number,
  py: number,
  factor: number,
  minK: number,
  maxK: number
): ViewTransform {
  const k2 = clamp(view.k * factor, minK, maxK);
  const f = k2 / view.k;
  return {
    x: px - f * (px - view.x),
    y: py - f * (py - view.y),
    k: k2,
  };
}

export function panView(
  view: ViewTransform,
  dx: number,
  dy: number
): ViewTransform {
  return { x: view.x + dx, y: view.y + dy, k: view.k };
}

export function clientToViewBox(
  rect: { left: number; top: number; width: number; height: number },
  viewSize: number,
  clientX: number,
  clientY: number
): { x: number; y: number } | null {
  if (rect.width <= 0 || rect.height <= 0) return null;
  return {
    x: ((clientX - rect.left) / rect.width) * viewSize,
    y: ((clientY - rect.top) / rect.height) * viewSize,
  };
}

export const PALETTE_HUES = [
  "amber",
  "forest",
  "indigo",
  "ochre",
  "rose",
  "slate",
  "teal",
  "violet",
] as const;

export function sortedPacks(nodes: readonly AtlasGraphNode[]): string[] {
  return [...new Set(nodes.map((n) => n.pack))].sort();
}

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
  bearing: Map<string, number>;
  labelTier: Map<string, 0 | 1>;
  sectors: PackSector[];
}

export function allocateBearings(
  nodes: readonly AtlasGraphNode[]
): BearingLayout {
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
      .sort((x, y) =>
        x.physical < y.physical ? -1 : x.physical > y.physical ? 1 : 0
      );
    const span = (360 * list.length) / total;
    const pad = Math.min(2.2, span * 0.14);
    const inner = span - pad * 2;
    list.forEach((n, i) => {
      const b =
        list.length === 1
          ? a + span / 2
          : a + pad + (i + 0.5) * (inner / list.length);
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

export function bfsHops(
  center: string,
  edges: readonly AtlasFkEdge[],
  allTables: readonly string[]
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

export function unreachedFrom(
  center: string,
  edges: readonly AtlasFkEdge[],
  allTables: readonly string[]
): string[] {
  const hops = bfsHops(center, edges, allTables);
  return allTables.filter((t) => hops.get(t) === null);
}

// The detail dial is a FILTER, never an aggregation: it never synthesizes or
// collapses a kind. Bearings stay fixed, and hop distance is computed over the
// FULL edge set, so a visible kind routed through a hidden one keeps its ring.

export type AtlasDetailLevel = "simple" | "standard" | "everything";

/** An UNKNOWN row count counts as zero; a ghost edge never counts as data. */
export function kindCarriesData(
  physical: string,
  rows: ReadonlyMap<string, number>,
  edges: readonly AtlasFkEdge[]
): boolean {
  const own = rows.get(physical);
  if (own !== undefined && own > 0) return true;
  return edges.some(
    (e) => (e.fromTable === physical || e.toTable === physical) && e.fill > 0
  );
}

export interface VisibilityContext {
  center: string;
  hops: ReadonlyMap<string, number | null>;
  rows: ReadonlyMap<string, number>;
  edges: readonly AtlasFkEdge[];
}

/** Never hides the CURRENT CENTRE: a re-centre keeps that kind on the plate. */
export function visibleAtLevel(
  level: AtlasDetailLevel,
  node: AtlasGraphNode,
  ctx: VisibilityContext
): boolean {
  if (node.physical === ctx.center) return true; // the dial never hides the centre
  if (level === "everything") return true;
  if (level === "simple") {
    if (node.packKind === "machinery") return false; // plumbing, hidden at Simple
    return kindCarriesData(node.physical, ctx.rows, ctx.edges);
  }
  if (node.packKind === "ontology") return true;
  return ctx.hops.get(node.physical) != null;
}

/** Both endpoints must be VISIBLE, and `visible` must include the centre. */
export function edgeVisibleAtLevel(
  level: AtlasDetailLevel,
  edge: AtlasFkEdge,
  visible: ReadonlySet<string>
): boolean {
  if (edge.selfRef) return false;
  if (level === "simple" && edge.ghost) return false;
  return visible.has(edge.fromTable) && visible.has(edge.toTable);
}

export function ringRadius(hop: number | null): number {
  if (hop === null) return ORRERY.ringUnreached;
  if (hop <= 0) return 0; // the centre itself
  if (hop === 1) return ORRERY.ringHop1;
  if (hop === 2) return ORRERY.ringHop2;
  return ORRERY.ringHop3;
}

export function polar(
  bearingDeg: number,
  radius: number
): { x: number; y: number } {
  const a = (bearingDeg * Math.PI) / 180;
  return {
    x: ORRERY.cx + Math.cos(a) * radius,
    y: ORRERY.cy + Math.sin(a) * radius,
  };
}

export function fillStrokeWidth(fill: number, maxFill: number): number {
  if (fill <= 0) return 0.7;
  const denom = Math.log10(Math.max(maxFill, 1) + 1) || 1;
  const l = Math.log10(fill + 1) / denom; // 0..1
  return Number((0.5 + 5 * l * l).toFixed(2));
}

export function fillStrokeOpacity(
  fill: number,
  maxFill: number,
  notnull: boolean
): number {
  const denom = Math.log10(Math.max(maxFill, 1) + 1) || 1;
  const l = fill <= 0 ? 0 : Math.log10(fill + 1) / denom;
  const base = 0.3 + 0.45 * l;
  return Number((notnull ? base : base * 0.8).toFixed(2));
}

const r1 = (n: number): string => n.toFixed(1);

/** A fixed bow on a near-straight chord folds it into a hairpin. */
export function edgeBow(fromDeg: number, toDeg: number): number {
  let sep = Math.abs(fromDeg - toDeg) % 360;
  if (sep > 180) sep = 360 - sep;
  return Number((1 - 0.24 * (sep / 180)).toFixed(3));
}

export function edgePath(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  bow: number
): string {
  const mx = (ax + bx) / 2;
  const my = (ay + by) / 2;
  const qx = ORRERY.cx + (mx - ORRERY.cx) * bow;
  const qy = ORRERY.cy + (my - ORRERY.cy) * bow;
  return `M ${r1(ax)} ${r1(ay)} Q ${r1(qx)} ${r1(qy)} ${r1(bx)} ${r1(by)}`;
}

/** `flip` keeps a `<textPath>` upright in the bottom half of the dial. */
export function dialArcPath(
  a1: number,
  a2: number,
  r: number,
  flip: boolean
): string {
  const s = polar(flip ? a2 : a1, r);
  const e = polar(flip ? a1 : a2, r);
  const large = Math.abs(a2 - a1) > 180 ? 1 : 0;
  const sweep = flip ? 0 : 1;
  return `M ${r1(s.x)} ${r1(s.y)} A ${r1(r)} ${r1(r)} 0 ${large} ${sweep} ${r1(e.x)} ${r1(e.y)}`;
}

export function sectorFlipped(midDeg: number): boolean {
  const m = ((midDeg % 360) + 360) % 360;
  return m > 0 && m < 180;
}

export function nodeRadius(rows: number | undefined): number {
  if (rows === undefined) return 5;
  if (rows <= 0) return 4;
  return Number(Math.min(11, 3 + 1.1 * rows ** 0.28).toFixed(2));
}

export function rowsByTable(
  edges: readonly AtlasFkEdge[]
): Map<string, number> {
  const m = new Map<string, number>();
  for (const e of edges)
    if (!m.has(e.fromTable)) m.set(e.fromTable, e.childRows);
  return m;
}

/** core_link is a SEPARATE mechanism from structural FKs; never conflate them. */
export interface RelationChip {
  key: string;
  label: string;
  count: number;
}

export function aggregateRelationChips(
  links: readonly AtlasAuthoredLink[]
): RelationChip[] {
  const byKey = new Map<string, RelationChip>();
  for (const link of links) {
    const key = link.relationLabel ?? link.relationConceptId;
    const label = link.relationLabel ?? "untyped link";
    const existing = byKey.get(key);
    if (existing) existing.count += link.count;
    else byKey.set(key, { key, label, count: link.count });
  }
  return [...byKey.values()].sort((a, b) => b.count - a.count);
}
