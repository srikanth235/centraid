import { describe, expect, it } from 'vitest';
import {
  ZOOM_MAX,
  ZOOM_MIN,
  type AtlasDetailLevel,
  allocateBearings,
  bfsHops,
  clientToViewBox,
  edgeVisibleAtLevel,
  fillStrokeWidth,
  kindCarriesData,
  panView,
  ringRadius,
  unreachedFrom,
  visibleAtLevel,
  zoomView,
} from './atlasOrreryGeometry.js';
import { edge, makeGraph, node } from './atlasRelationsTestKit.js';
import type { AtlasFkEdge } from '../../gateway-client.js';

// ── Geometry (pure functions) ───────────────────────────────────────────────
describe('atlasOrreryGeometry', () => {
  it('undirected BFS unreached set equals the payload island for the default centre', () => {
    const g = makeGraph();
    const tables = g.nodes.map((n) => n.physical);
    const unreached = unreachedFrom('core_party', g.fkEdges, tables);
    expect(new Set(unreached)).toEqual(new Set(g.island));
  });

  it('hop distances grow with graph distance from the centre', () => {
    const g = makeGraph();
    const tables = g.nodes.map((n) => n.physical);
    const hops = bfsHops('core_party', g.fkEdges, tables);
    expect(hops.get('core_party')).toBe(0);
    expect(hops.get('core_observation')).toBe(1); // references core_party
    expect(hops.get('health_vital')).toBe(2); // references core_observation
    expect(hops.get('sync_connection')).toBeNull(); // island
  });

  it('fill weighting is monotonic and gives ghosts a hairline', () => {
    const max = 41230;
    const wSpine = fillStrokeWidth(41230, max);
    const wMid = fillStrokeWidth(742, max);
    const wThin = fillStrokeWidth(10, max);
    expect(wSpine).toBeGreaterThan(wMid);
    expect(wMid).toBeGreaterThan(wThin);
    expect(fillStrokeWidth(0, max)).toBe(0.7);
  });

  it('bearings are stable and independent of any centre (the anti-hairball invariant)', () => {
    const g = makeGraph();
    const a = allocateBearings(g.nodes);
    const b = allocateBearings(g.nodes);
    for (const n of g.nodes) {
      expect(a.bearing.get(n.physical)).toBe(b.bearing.get(n.physical));
    }
    // sectors partition a full turn, packs in stable name order
    const names = a.sectors.map((s) => s.pack);
    expect(names).toEqual([...names].sort());
  });

  it('ring radius places unreached beyond hop 3+', () => {
    expect(ringRadius(0)).toBe(0);
    expect(ringRadius(1)).toBeLessThan(ringRadius(2));
    expect(ringRadius(2)).toBeLessThan(ringRadius(4));
    expect(ringRadius(null)).toBeGreaterThan(ringRadius(4));
  });

  // ── Pan/zoom camera maths ─────────────────────────────────────────────────
  it('zoomView clamps k at both bounds (no zooming past the stops)', () => {
    // pushing past the ceiling pins k at ZOOM_MAX
    expect(zoomView({ x: 0, y: 0, k: ZOOM_MAX }, 310, 310, 2, ZOOM_MIN, ZOOM_MAX).k).toBe(ZOOM_MAX);
    // pushing past the floor pins k at ZOOM_MIN
    expect(zoomView({ x: 0, y: 0, k: ZOOM_MIN }, 310, 310, 0.1, ZOOM_MIN, ZOOM_MAX).k).toBe(
      ZOOM_MIN,
    );
  });

  it('zoomView keeps the zoom-about point fixed on screen', () => {
    const v0 = { x: 20, y: -30, k: 1.4 };
    const px = 200;
    const py = 150;
    const v1 = zoomView(v0, px, py, 1.7, ZOOM_MIN, ZOOM_MAX);
    // the local point under (px,py) before the zoom…
    const qx = (px - v0.x) / v0.k;
    const qy = (py - v0.y) / v0.k;
    // …must still map to (px,py) after the zoom
    expect(v1.x + v1.k * qx).toBeCloseTo(px, 6);
    expect(v1.y + v1.k * qy).toBeCloseTo(py, 6);
    expect(v1.k).toBeGreaterThan(v0.k);
  });

  it('panView translates without touching k', () => {
    expect(panView({ x: 5, y: 7, k: 2 }, 3, -4)).toEqual({ x: 8, y: 3, k: 2 });
  });

  it('clientToViewBox maps by ratio and returns null on a degenerate rect', () => {
    // jsdom reports zero-size rects — must fall back to null (→ centre zoom)
    expect(clientToViewBox({ left: 0, top: 0, width: 0, height: 0 }, 620, 10, 10)).toBeNull();
    // a full-size square rect maps client px straight onto viewBox coords
    expect(clientToViewBox({ left: 0, top: 0, width: 620, height: 620 }, 620, 155, 310)).toEqual({
      x: 155,
      y: 310,
    });
    // an offset, half-scale rect maps its top-left corner to the origin
    expect(clientToViewBox({ left: 100, top: 50, width: 310, height: 310 }, 620, 100, 50)).toEqual({
      x: 0,
      y: 0,
    });
  });
});

// ── Detail-dial filter predicates (pure) ────────────────────────────────────
describe('detail-dial filter predicates', () => {
  it('kindCarriesData: known rows>0 carry; zero/unknown need a live incident edge', () => {
    const rows = new Map<string, number>([
      ['a_full', 10],
      ['b_zero', 0],
    ]);
    const edges: AtlasFkEdge[] = [
      // b_zero has no rows of its own but a live edge leaves it → carries data
      edge('b_zero', 'target_id', 'c_target', { childRows: 0, fill: 5 }),
      // d_lonely's only edge is a ghost (fill 0) → no proof of data
      edge('d_lonely', 'x_id', 'e_dead', { notnull: false, fill: 0, ghost: true }),
    ];
    expect(kindCarriesData('a_full', rows, edges)).toBe(true); // own rows > 0
    expect(kindCarriesData('b_zero', rows, edges)).toBe(true); // 0 rows, but a live edge
    expect(kindCarriesData('c_target', rows, edges)).toBe(true); // unknown rows, live edge arrives
    expect(kindCarriesData('d_lonely', rows, edges)).toBe(false); // unknown rows, only a ghost
    expect(kindCarriesData('e_dead', rows, edges)).toBe(false); // unknown rows, only a ghost
  });

  it('visibleAtLevel: the centre always shows, even when the level would hide it', () => {
    const emptyCentre = node('x_empty', 'x', 'ontology'); // no data, would be hidden at simple
    const ctx = {
      center: 'x_empty',
      hops: new Map<string, number | null>(),
      rows: new Map<string, number>(),
      edges: [] as AtlasFkEdge[],
    };
    for (const lvl of ['simple', 'standard', 'everything'] as AtlasDetailLevel[])
      expect(visibleAtLevel(lvl, emptyCentre, ctx)).toBe(true);
  });

  it('visibleAtLevel: simple keeps ontology-with-data, hides empty ontology and all machinery', () => {
    const ctx = {
      center: 'core_party',
      hops: new Map<string, number | null>(),
      rows: new Map<string, number>([['health_vital', 3]]),
      edges: [] as AtlasFkEdge[],
    };
    expect(visibleAtLevel('simple', node('health_vital', 'health', 'ontology'), ctx)).toBe(true);
    expect(visibleAtLevel('simple', node('knowledge_tag', 'knowledge', 'ontology'), ctx)).toBe(
      false,
    );
    // reachable machinery is still plumbing → hidden at simple
    expect(visibleAtLevel('simple', node('consent_device', 'consent', 'machinery'), ctx)).toBe(
      false,
    );
  });

  it('visibleAtLevel: standard shows reachable machinery only; everything shows the island too', () => {
    const ctx = {
      center: 'core_party',
      hops: new Map<string, number | null>([
        ['consent_device', 2],
        ['sync_connection', null],
      ]),
      rows: new Map<string, number>(),
      edges: [] as AtlasFkEdge[],
    };
    const reachable = node('consent_device', 'consent', 'machinery');
    const island = node('sync_connection', 'sync', 'machinery');
    expect(visibleAtLevel('standard', reachable, ctx)).toBe(true);
    expect(visibleAtLevel('standard', island, ctx)).toBe(false); // unreachable machinery
    expect(visibleAtLevel('everything', island, ctx)).toBe(true); // everything reveals it
  });

  it('edgeVisibleAtLevel: needs both endpoints; drops self-refs; hides ghosts only at simple', () => {
    const visible = new Set(['core_observation', 'core_party', 'consent_device']);
    const live = edge('core_observation', 'subject_party_id', 'core_party', { fill: 10 });
    const ghost = edge('core_observation', 'cover_id', 'core_party', {
      notnull: false,
      fill: 0,
      ghost: true,
    });
    const hidden = edge('core_observation', 'note_id', 'knowledge_note', { fill: 3 });
    const self = edge('core_concept', 'broader_id', 'core_concept', { fill: 2, selfRef: true });
    expect(edgeVisibleAtLevel('simple', live, visible)).toBe(true);
    expect(edgeVisibleAtLevel('simple', ghost, visible)).toBe(false); // ghost hidden at simple
    expect(edgeVisibleAtLevel('standard', ghost, visible)).toBe(true); // …but shown at standard
    expect(edgeVisibleAtLevel('everything', hidden, visible)).toBe(false); // endpoint not visible
    expect(edgeVisibleAtLevel('everything', self, visible)).toBe(false); // self-ref never an edge
  });
});
