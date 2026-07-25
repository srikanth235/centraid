// Pure, deterministic geometry + hierarchy derivation for the Vault Atlas Map
// (issue #519 follow-on). Kept out of the components so the maths and the
// visibility rules can be tested directly.
//
// The invariant this module exists to protect — and the reason the previous
// orrery had to go — is:
//
//   PRESENCE IS CATEGORICAL, QUANTITY IS RADIAL.
//
// Every domain gets an EQUAL angular span, and every kind inside a domain gets
// an equal span of that domain. Nothing is ever a 4° slice because its schema
// happens to declare one table, and nothing is ever removed because it holds no
// rows. How much you have moves the wedge's OUTER RADIUS and nothing else — an
// empty kind still reaches `ringFloor`, so it keeps a real, clickable target.
// The old Simple/Standard/Everything dial filtered kinds out by row count,
// which made whole domains unreachable; that is precisely what this replaces.

import type { AtlasCensusPayload, AtlasFkEdge, AtlasGraphPayload } from '../../gateway-client.js';

/** Fixed square canvas. Radii are viewBox units, not pixels. */
export const SUNBURST = {
  cx: 280,
  cy: 280,
  view: 560,
  /** The centre plate — the rung you stand on, and the way back up. */
  coreR: 62,
  /** Inner edge of the working ring. */
  ringIn: 76,
  /** How far a wedge with NO rows still reaches. Never zero, and deliberately
   *  a SUBSTANTIAL band rather than a hairline — an empty domain has to read as
   *  present at a glance, not as a smudge near the middle. */
  ringFloor: 112,
  /** How far the fullest sibling reaches. */
  ringOut: 194,
  /** The same two bounds on a rung whose labels radiate outward and therefore
   *  need the space beyond the ring (see `ringBounds`). */
  ringFloorRadial: 88,
  ringOutRadial: 150,
  /** Clearance between a wedge's outer edge and its label. */
  labelGap: 11,
  /** The bezel: every domain at a fixed bearing, drawn only when drilled in. */
  bezelIn: 236,
  bezelOut: 248,
  bezelLabelR: 260,
} as const;

/**
 * The chromatic app-icon hues (`--c-*` tokens), ordered for MAXIMUM separation
 * between adjacent slots rather than alphabetically. The palette's declaration
 * order puts `amber` (#E89A3C) and `ochre` (#B47B3F) three apart — two browns a
 * viewer reads as one colour — and spends slot 5 on `slate`, a grey that makes
 * whatever domain lands there look disabled. Walking the ramp in this order,
 * no two neighbouring domains ever share a family.
 *
 * `slate` is deliberately absent: see MACHINERY_HUE.
 */
export const PALETTE_HUES = [
  'teal',
  'rose',
  'indigo',
  'amber',
  'violet',
  'forest',
  'ochre',
] as const;

/** Machinery bands paint grey, always — plumbing looks like plumbing, and the
 *  seven chromatic hues are never spent on a band the map hides by default. */
export const MACHINERY_HUE = 'slate';

const hueVar = (hue: string): string => `var(--c-${hue})`;

/**
 * How much of the base hue survives at position `index` of `count` siblings.
 * Kinds inside one domain sweep from the domain's own hue toward the NEXT hue
 * on the ramp, so a 21-kind fan reads as a spectrum instead of 21 identical
 * wedges.
 *
 * The sweep stops at 68%, not 0%: the CSS mixes in oklch, where the remaining
 * 32% is still a visible hue rotation, and travelling further would land the
 * far end of a domain's fan on a colour its own bezel arc contradicts. Rich
 * enough to read as a ramp, short enough that the domain keeps its identity.
 */
export const TONE_SWEEP = 32;

export function toneMix(index: number, count: number): string {
  if (count <= 1 || index <= 0) return '100%';
  const t = Math.min(index, count - 1) / (count - 1);
  return `${(100 - t * TONE_SWEEP).toFixed(1)}%`;
}

/** The pair of `--c-*` tokens a pack paints between. */
export interface PackHues {
  hue: string;
  /** The far end of the domain's internal sweep — equal to `hue` for machinery,
   *  which stays flat grey rather than becoming a second rainbow. */
  hue2: string;
}

/**
 * Assign every pack its hue pair. Ontology packs take chromatic slots by their
 * ordinal AMONG ONTOLOGY PACKS — so a machinery band sitting in the middle of
 * the registry order never pushes the ontology ramp out of step.
 */
export function assignHues(
  packs: readonly { pack: string; packKind: 'ontology' | 'machinery' }[],
): Map<string, PackHues> {
  const out = new Map<string, PackHues>();
  let n = 0;
  for (const p of packs) {
    if (p.packKind === 'machinery') {
      out.set(p.pack, { hue: hueVar(MACHINERY_HUE), hue2: hueVar(MACHINERY_HUE) });
      continue;
    }
    const i = n++ % PALETTE_HUES.length;
    out.set(p.pack, {
      hue: hueVar(PALETTE_HUES[i] as string),
      hue2: hueVar(PALETTE_HUES[(i + 1) % PALETTE_HUES.length] as string),
    });
  }
  return out;
}

// ── The hierarchy ───────────────────────────────────────────────────────────

/** One kind, joined from the census (exact rows) and the graph (human name). */
export interface SunburstKind {
  /** Logical `schema.table` — the stable id at the kind rung. */
  logical: string;
  physical: string;
  /** Curated human name where the graph supplies one, else the census label. */
  name: string;
  /** Curated one-line blurb, or '' when the server emits none. Never invented. */
  blurb: string;
  rows: number;
}

/** One domain (== pack). Always rendered, whatever it holds. */
export interface SunburstDomain extends PackHues {
  pack: string;
  label: string;
  packKind: 'ontology' | 'machinery';
  kinds: SunburstKind[];
  /** Total rows across the domain's kinds — from the census, never derived. */
  rows: number;
}

/**
 * Join the census (the only source of exact per-table row counts) with the
 * graph (the only source of curated friendly names and blurbs). The census is
 * required; the graph is an ENHANCEMENT — when it is absent every kind simply
 * falls back to its mechanical census label and carries no blurb. We never
 * fabricate a name or a description that the server did not send.
 *
 * Pack and table order is the census's own registry order, so a domain's
 * bearing is stable across reloads.
 */
export function buildDomains(
  stats: AtlasCensusPayload,
  graph: AtlasGraphPayload | null,
): SunburstDomain[] {
  const nodeByLogical = new Map((graph?.nodes ?? []).map((n) => [n.logical, n]));
  const hues = assignHues(stats.packs);
  const grey: PackHues = { hue: `var(--c-${MACHINERY_HUE})`, hue2: `var(--c-${MACHINERY_HUE})` };
  return stats.packs.map((pack) => ({
    ...(hues.get(pack.pack) ?? grey),
    pack: pack.pack,
    label: pack.packLabel,
    packKind: pack.packKind,
    rows: pack.rows,
    kinds: pack.tables.map((t) => {
      const node = nodeByLogical.get(t.logical);
      return {
        logical: t.logical,
        physical: t.physical,
        name: node?.friendly ?? t.label,
        blurb: node?.blurb ?? '',
        rows: t.rows,
      };
    }),
  }));
}

/**
 * The domains a given plumbing setting shows. This is the ONLY thing that ever
 * removes a domain from the map, it is driven by an explicit user switch (not
 * by emptiness), and it is additive — turning it on reveals machinery, turning
 * it off never hides ontology. Contrast the old detail dial, which hid a
 * domain the moment its kinds held no rows.
 */
export function visibleDomains(
  domains: readonly SunburstDomain[],
  plumbing: boolean,
): SunburstDomain[] {
  return domains.filter((d) => plumbing || d.packKind === 'ontology');
}

/** One wedge of the working ring — a domain at the root rung, a kind inside. */
export interface RingItem extends PackHues {
  /** Stable id: the pack name at the domain rung, the logical at the kind rung. */
  id: string;
  name: string;
  /** Blurb for a kind; "5 kinds" for a domain. */
  detail: string;
  rows: number;
  /** No rows. A rendered STATE — never a reason to omit the wedge. */
  empty: boolean;
  /** Which pack this wedge belongs to. */
  pack: string;
  /** Where between `hue` and `hue2` this wedge lands, as a CSS percentage.
   *  `100%` at the domain rung: domains carry their own distinct hues and have
   *  no siblings to sweep across. */
  mix: string;
}

/** The children of the current rung: the visible domains at the root, or one
 *  domain's kinds when focused. A focused domain that the plumbing switch would
 *  hide still lists its kinds — you can only be there by having asked. */
export function ringItems(
  domains: readonly SunburstDomain[],
  plumbing: boolean,
  focus: string | null,
): RingItem[] {
  if (focus === null) {
    return visibleDomains(domains, plumbing).map((d) => ({
      id: d.pack,
      name: d.label,
      detail: `${d.kinds.length} ${d.kinds.length === 1 ? 'kind' : 'kinds'}`,
      rows: d.rows,
      empty: d.rows === 0,
      pack: d.pack,
      hue: d.hue,
      hue2: d.hue2,
      mix: '100%',
    }));
  }
  const d = domains.find((x) => x.pack === focus);
  if (!d) return [];
  return d.kinds.map((k, i) => ({
    id: k.logical,
    name: k.name,
    detail: k.blurb,
    rows: k.rows,
    empty: k.rows === 0,
    pack: d.pack,
    hue: d.hue,
    hue2: d.hue2,
    mix: toneMix(i, d.kinds.length),
  }));
}

/** Look up one kind by its logical name across every domain. */
export function findKind(
  domains: readonly SunburstDomain[],
  logical: string,
): { domain: SunburstDomain; kind: SunburstKind } | null {
  for (const domain of domains) {
    const kind = domain.kinds.find((k) => k.logical === logical);
    if (kind) return { domain, kind };
  }
  return null;
}

/**
 * The distinct kinds an FK edge connects this one to, in either direction —
 * the graph, rendered as a walkable list instead of an arc thicket. Self-
 * references are excluded (a hierarchy is not a neighbour), and a physical
 * table the census does not know is skipped rather than guessed at.
 */
export function neighboursOf(
  edges: readonly AtlasFkEdge[],
  physical: string,
  byPhysical: ReadonlyMap<string, SunburstKind>,
): SunburstKind[] {
  const seen = new Set<string>();
  const out: SunburstKind[] = [];
  for (const e of edges) {
    if (e.selfRef) continue;
    const other =
      e.fromTable === physical ? e.toTable : e.toTable === physical ? e.fromTable : null;
    if (other === null || other === physical || seen.has(other)) continue;
    seen.add(other);
    const kind = byPhysical.get(other);
    if (kind) out.push(kind);
  }
  // Fullest first — the neighbour most likely to be worth walking to.
  return out.sort((a, b) => b.rows - a.rows);
}

/** Every kind in the vault, indexed by physical table name. */
export function kindsByPhysical(domains: readonly SunburstDomain[]): Map<string, SunburstKind> {
  const m = new Map<string, SunburstKind>();
  for (const d of domains) for (const k of d.kinds) m.set(k.physical, k);
  return m;
}

// ── The maths ───────────────────────────────────────────────────────────────

const rad = (deg: number): number => (deg * Math.PI) / 180;
const r1 = (n: number): string => n.toFixed(1);

/** Cartesian point for a bearing (degrees, 0 = 3 o'clock) and radius. */
export function polar(bearingDeg: number, radius: number): { x: number; y: number } {
  return {
    x: SUNBURST.cx + Math.cos(rad(bearingDeg)) * radius,
    y: SUNBURST.cy + Math.sin(rad(bearingDeg)) * radius,
  };
}

/** One wedge's angular bounds. Spans are EQUAL — `count` children each take
 *  `360 / count`, starting at 12 o'clock and running clockwise. The gap is a
 *  hairline so neighbouring wedges read as separate targets. */
export function wedgeAngles(
  index: number,
  count: number,
): { start: number; end: number; mid: number } {
  const span = 360 / Math.max(count, 1);
  const pad = count === 1 ? 0 : Math.min(1.6, span * 0.06);
  const start = -90 + index * span + pad;
  const end = -90 + (index + 1) * span - pad;
  return { start, end, mid: (start + end) / 2 };
}

/**
 * The ring's inner/outer bounds for a label mode. A rung whose labels radiate
 * outward needs that space to exist: a 21-kind domain with a name like
 * "observation component" would otherwise run straight off the canvas. So the
 * ring itself yields — the wedges get shorter, the labels get room, and the
 * proportions between wedges are untouched because both bounds scale together.
 */
export function ringBounds(mode: LabelMode = 'upright'): { floor: number; out: number } {
  return mode === 'radial'
    ? { floor: SUNBURST.ringFloorRadial, out: SUNBURST.ringOutRadial }
    : { floor: SUNBURST.ringFloor, out: SUNBURST.ringOut };
}

/**
 * How far a wedge holding `rows` reaches, against the fullest sibling. Empty is
 * the FLOOR, not zero: an empty kind keeps a full-width, comfortably clickable
 * band. The curve is a 0.42 power so a 44,902-row kind reads heavier than a
 * 200-row one without a long tail of invisible slivers.
 */
export function reachRadius(rows: number, maxRows: number, mode: LabelMode = 'upright'): number {
  const { floor, out } = ringBounds(mode);
  if (rows <= 0) return floor;
  const t = (rows / Math.max(maxRows, 1)) ** 0.42;
  return Number((floor + (out - floor) * t).toFixed(2));
}

/** Longest ring label before it is clipped. The index beside the ring always
 *  carries the full name, and so does the wedge's `aria-label`, so shortening
 *  here costs nothing a reader cannot immediately recover. */
export const LABEL_MAX_CHARS = 18;

export function truncateLabel(name: string, max: number = LABEL_MAX_CHARS): string {
  return name.length <= max ? name : `${name.slice(0, max - 1).trimEnd()}…`;
}

/**
 * Annular-sector path between two bearings and two radii. A single child spans
 * the whole circle, which no single arc can express, so that case is drawn as
 * two counter-wound circles — an annulus under the default nonzero fill rule.
 */
export function sectorPath(a0: number, a1: number, rIn: number, rOut: number): string {
  if (Math.abs(a1 - a0) >= 359.9) {
    const o = SUNBURST.cx + rOut;
    const oL = SUNBURST.cx - rOut;
    const i = SUNBURST.cx + rIn;
    const iL = SUNBURST.cx - rIn;
    const cy = SUNBURST.cy;
    return (
      `M${r1(o)} ${r1(cy)}A${r1(rOut)} ${r1(rOut)} 0 1 1 ${r1(oL)} ${r1(cy)}` +
      `A${r1(rOut)} ${r1(rOut)} 0 1 1 ${r1(o)} ${r1(cy)}Z` +
      `M${r1(i)} ${r1(cy)}A${r1(rIn)} ${r1(rIn)} 0 1 0 ${r1(iL)} ${r1(cy)}` +
      `A${r1(rIn)} ${r1(rIn)} 0 1 0 ${r1(i)} ${r1(cy)}Z`
    );
  }
  const large = Math.abs(a1 - a0) > 180 ? 1 : 0;
  const p0 = polar(a0, rOut);
  const p1 = polar(a1, rOut);
  const p2 = polar(a1, rIn);
  const p3 = polar(a0, rIn);
  return (
    `M${r1(p0.x)} ${r1(p0.y)}A${r1(rOut)} ${r1(rOut)} 0 ${large} 1 ${r1(p1.x)} ${r1(p1.y)}` +
    `L${r1(p2.x)} ${r1(p2.y)}A${r1(rIn)} ${r1(rIn)} 0 ${large} 0 ${r1(p3.x)} ${r1(p3.y)}Z`
  );
}

/** Circular-arc path for a `<textPath>` label. With `flip` the arc runs
 *  counterclockwise so text in the bottom half reads upright, not upside-down. */
export function labelArcPath(a0: number, a1: number, radius: number, flip: boolean): string {
  const s = polar(flip ? a1 : a0, radius);
  const e = polar(flip ? a0 : a1, radius);
  const large = Math.abs(a1 - a0) > 180 ? 1 : 0;
  return `M${r1(s.x)} ${r1(s.y)}A${r1(radius)} ${r1(radius)} 0 ${large} ${flip ? 0 : 1} ${r1(e.x)} ${r1(e.y)}`;
}

/** Whether a label at this mid-bearing would read upside-down unflipped —
 *  true in the bottom half of the dial (SVG y grows downward). */
export function labelFlipped(midDeg: number): boolean {
  const m = ((midDeg % 360) + 360) % 360;
  return m > 0 && m < 180;
}

/**
 * How a rung's labels are set. Up to `UPRIGHT_MAX` children there is room to set
 * every label FLAT — plain horizontal text just outside its wedge, which is the
 * most legible option there is. Past that the labels would collide near 12 and 6
 * o'clock, so they rotate to point outward instead. Core's 21 kinds are the case
 * that forces the second mode.
 *
 * Text following the arc was tried and rejected: at 5 domains the left-hand
 * labels end up reading bottom-to-top, which is exactly the rotated-label
 * illegibility the old orrery was criticised for.
 */
export const UPRIGHT_MAX = 12;

export type LabelMode = 'upright' | 'radial';

export function labelMode(count: number): LabelMode {
  return count <= UPRIGHT_MAX ? 'upright' : 'radial';
}

/**
 * Where a wedge's label sits: just beyond ITS OWN outer edge, never at a fixed
 * radius. A fixed radius strands an empty wedge's label out by the rim with a
 * gap of nothing between them, which reads as a rendering fault rather than as
 * "this one is empty".
 */
export function labelRadius(outerRadius: number): number {
  return outerRadius + SUNBURST.labelGap;
}

/**
 * Placement for one label. Text on the left half is anchored at its end so it
 * always grows AWAY from the ring rather than back across it. In `radial` mode
 * it is additionally rotated to lie along the bearing (and flipped a further
 * 180° on the left) so it still reads left-to-right.
 */
export function labelPlacement(
  midDeg: number,
  radius: number,
  mode: LabelMode,
): { x: number; y: number; rotate: number; anchor: 'start' | 'end' } {
  const p = polar(midDeg, radius);
  const left = Math.cos(rad(midDeg)) < 0;
  return {
    x: p.x,
    y: p.y,
    rotate: mode === 'upright' ? 0 : left ? midDeg + 180 : midDeg,
    anchor: left ? 'end' : 'start',
  };
}
