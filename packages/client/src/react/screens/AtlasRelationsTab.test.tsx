import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import AtlasRelationsTab from './AtlasRelationsTab.js';
import {
  allocateBearings,
  bfsHops,
  fillStrokeWidth,
  ringRadius,
  unreachedFrom,
} from './atlasOrreryGeometry.js';
import type { AtlasFkEdge, AtlasGraphNode, AtlasGraphPayload } from '../../gateway-client.js';

// ── Sample payload ────────────────────────────────────────────────────────
// A slice of the real vault graph: core_party at the hub, a health/observation
// chain (the readout example), a self-referencing concept, one ghost edge, and
// the genuinely-disconnected locker/sync island.
const node = (
  physical: string,
  pack: string,
  packKind: 'ontology' | 'machinery',
  over: Partial<AtlasGraphNode> = {},
): AtlasGraphNode => {
  const table = physical.slice(physical.indexOf('_') + 1);
  return {
    physical,
    logical: `${pack}.${table}`,
    table,
    label: table.replace(/_/g, ' '),
    pack,
    packKind,
    packLabel: (pack[0]?.toUpperCase() ?? '') + pack.slice(1),
    hopDistance: null,
    selfRef: false,
    ...over,
  };
};

const edge = (
  fromTable: string,
  col: string,
  toTable: string,
  over: Partial<AtlasFkEdge>,
): AtlasFkEdge => ({
  fromTable,
  fromLogical: fromTable,
  fromPack: fromTable.split('_')[0] ?? fromTable,
  col,
  toTable,
  toLogical: toTable,
  toPack: toTable.split('_')[0] ?? toTable,
  notnull: true,
  childRows: 0,
  fill: 0,
  ghost: false,
  selfRef: false,
  ...over,
});

function makeGraph(over: Partial<AtlasGraphPayload> = {}): AtlasGraphPayload {
  const nodes: AtlasGraphNode[] = [
    node('core_party', 'core', 'ontology'),
    node('core_observation', 'core', 'ontology'),
    node('core_concept', 'core', 'ontology', { selfRef: true }),
    node('health_vital', 'health', 'ontology'),
    node('knowledge_note', 'knowledge', 'ontology'),
    node('consent_device', 'consent', 'machinery'), // reachable machinery → renders
    node('locker_item', 'locker', 'ontology'),
    node('locker_item_alias', 'locker', 'ontology'),
    node('sync_connection', 'sync', 'machinery'),
  ];
  const fkEdges: AtlasFkEdge[] = [
    edge('health_vital', 'observation_id', 'core_observation', {
      childRows: 41230,
      fill: 41230,
    }),
    edge('core_observation', 'subject_party_id', 'core_party', {
      childRows: 44902,
      fill: 44902,
    }),
    edge('core_observation', 'device_id', 'consent_device', {
      notnull: false,
      childRows: 44902,
      fill: 44000,
    }),
    edge('knowledge_note', 'author_party_id', 'core_party', {
      childRows: 742,
      fill: 742,
    }),
    // makes core_concept reachable (hop 2 via knowledge_note)
    edge('knowledge_note', 'topic_concept_id', 'core_concept', {
      notnull: false,
      childRows: 742,
      fill: 520,
    }),
    // a ghost: nullable column no row ever sets
    edge('knowledge_note', 'cover_content_id', 'core_party', {
      notnull: false,
      childRows: 742,
      fill: 0,
      ghost: true,
    }),
    // self-reference — drawn as a glyph, not a loop edge
    edge('core_concept', 'broader_concept_id', 'core_concept', {
      notnull: false,
      childRows: 342,
      fill: 297,
      selfRef: true,
    }),
    // the isolated island
    edge('locker_item', 'connection_id', 'sync_connection', { childRows: 63, fill: 63 }),
    edge('locker_item_alias', 'item_id', 'locker_item', { childRows: 91, fill: 91 }),
  ];
  return {
    generatedAt: '2026-07-17T12:00:00.000Z',
    center: 'core_party',
    nodes,
    fkEdges,
    authoredLinks: [
      {
        relationConceptId: 'concept-mentions',
        relationLabel: 'mentions',
        fromType: 'knowledge.note',
        toType: 'core.party',
        count: 12,
      },
      {
        relationConceptId: 'concept-depicts',
        relationLabel: 'depicts',
        fromType: 'core.party',
        toType: 'core_observation',
        count: 4,
      },
    ],
    island: ['locker_item', 'locker_item_alias', 'sync_connection'],
    edgeCount: fkEdges.length,
    centerEdgeCount: fkEdges.filter((e) => e.toTable === 'core_party').length,
    selfRefCount: 1,
    ...over,
  };
}

// ── Mount harness (mirrors AtlasScreen.test) ────────────────────────────────
let root: Root | null = null;
let container: HTMLDivElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
});

async function mount(graph: AtlasGraphPayload | null): Promise<HTMLDivElement> {
  container = document.createElement('div');
  document.body.appendChild(container);
  await act(async () => {
    root = createRoot(container as HTMLDivElement);
    root.render(<AtlasRelationsTab graph={graph} />);
  });
  await act(async () => {
    await Promise.resolve();
  });
  return container;
}

const fire = async (node: Element | null | undefined, type: string): Promise<void> => {
  await act(async () => node?.dispatchEvent(new MouseEvent(type, { bubbles: true })));
  await act(async () => {
    await Promise.resolve();
  });
};

const nodeEl = (el: HTMLElement, physical: string): HTMLElement | null =>
  el.querySelector<HTMLElement>(`[data-testid="atlas-node"][data-physical="${physical}"]`);

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
});

// ── Component ───────────────────────────────────────────────────────────────
describe('AtlasRelationsTab', () => {
  it('renders a quiet empty state when the graph is null', async () => {
    const el = await mount(null);
    expect(el.querySelector('[data-testid="atlas-relations-empty"]')).toBeTruthy();
    expect(el.querySelector('[data-testid="atlas-orrery"]')).toBeNull();
  });

  it('renders nodes and FK edges from the payload', async () => {
    const el = await mount(makeGraph());
    const nodes = el.querySelectorAll('[data-testid="atlas-node"]');
    expect(nodes.length).toBeGreaterThan(0);
    // core_party is the centre — drawn as the plate, not a node
    expect(nodeEl(el, 'core_party')).toBeNull();
    // ontology kinds render, including the unreached island members
    expect(nodeEl(el, 'knowledge_note')).toBeTruthy();
    expect(nodeEl(el, 'locker_item')).toBeTruthy();
    // reachable machinery renders; unreachable machinery (sync_connection,
    // an island member) is hidden to keep the chart about the ontology
    expect(nodeEl(el, 'consent_device')).toBeTruthy();
    expect(nodeEl(el, 'sync_connection')).toBeNull();
    // FK edges present; the self-reference is excluded from the edge layer
    // (9 fkEdges − 1 self-ref = 8 drawable arcs)
    const edges = el.querySelectorAll('[data-testid="atlas-edge"]');
    expect(edges.length).toBe(8);
  });

  it('states the measured centre fact from centerEdgeCount / edgeCount', async () => {
    const el = await mount(makeGraph());
    const cap = el.querySelector('[data-testid="atlas-center-caption"]');
    // 3 of 9 edges point at core_party
    expect(cap?.textContent).toContain('3 of 9');
    expect(cap?.textContent).toContain('structural references point here');
  });

  it('draws the ghost edge with the dotted ghost class', async () => {
    const el = await mount(makeGraph());
    const ghost = el.querySelector<HTMLElement>('[data-testid="atlas-edge"][data-ghost="true"]');
    expect(ghost).toBeTruthy();
    expect(ghost?.getAttribute('class')).toContain('edgeGhost');
  });

  it('weights live edges by fill — a 41k-row spine outweighs a 742-row column', async () => {
    const el = await mount(makeGraph());
    const spine = el.querySelector<SVGPathElement>(
      '[data-testid="atlas-edge"][data-from="health_vital"][data-to="core_observation"]',
    );
    const note = el.querySelector<SVGPathElement>(
      '[data-testid="atlas-edge"][data-from="knowledge_note"][data-to="core_party"][data-ghost="false"]',
    );
    const w = (p: SVGPathElement | null): number =>
      parseFloat((p?.style.strokeWidth || '0').toString());
    expect(w(spine)).toBeGreaterThan(w(note));
  });

  it('marks self-referencing kinds with a curl glyph, not a loop edge', async () => {
    const el = await mount(makeGraph());
    const concept = nodeEl(el, 'core_concept');
    expect(concept?.dataset.selfref).toBe('true');
    expect(concept?.querySelector('[data-testid="atlas-selfref-glyph"]')).toBeTruthy();
  });

  it('puts unreached ontology kinds on the unreached ring, agreeing with island', async () => {
    const el = await mount(makeGraph());
    const locker = nodeEl(el, 'locker_item');
    expect(locker?.dataset.hop).toBe('unreached');
    // every rendered unreached node is an island member
    const unreachedRendered = [...el.querySelectorAll<HTMLElement>('[data-testid="atlas-node"]')]
      .filter((n) => n.dataset.hop === 'unreached')
      .map((n) => n.dataset.physical);
    for (const p of unreachedRendered) expect(makeGraph().island).toContain(p);
  });

  it('re-centres on click: hop rings change but bearings never move', async () => {
    const el = await mount(makeGraph());
    const vitalBefore = nodeEl(el, 'health_vital');
    const noteBearing = nodeEl(el, 'knowledge_note')?.dataset.bearing;
    expect(vitalBefore?.dataset.hop).toBe('2'); // 2 hops from core_party

    await fire(nodeEl(el, 'core_observation'), 'click');

    expect(el.querySelector<SVGElement>('[data-testid="atlas-orrery"]')?.dataset.center).toBe(
      'core_observation',
    );
    // health_vital is now one hop from the new centre
    expect(nodeEl(el, 'health_vital')?.dataset.hop).toBe('1');
    // …but knowledge_note's bearing is unchanged — the compass never spins
    expect(nodeEl(el, 'knowledge_note')?.dataset.bearing).toBe(noteBearing);
  });

  it('toggles the authored-link overlay from a relation chip', async () => {
    const el = await mount(makeGraph());
    expect(el.querySelector('[data-testid="atlas-authored-arc"]')).toBeNull();
    const chip = el.querySelector('[data-testid="atlas-relation-chip"][data-relation="mentions"]');
    expect(chip?.getAttribute('aria-pressed')).toBe('false');

    await fire(chip, 'click');
    expect(el.querySelector('[data-testid="atlas-authored-arc"]')).toBeTruthy();
    expect(
      el
        .querySelector('[data-testid="atlas-relation-chip"][data-relation="mentions"]')
        ?.getAttribute('aria-pressed'),
    ).toBe('true');

    await fire(
      el.querySelector('[data-testid="atlas-relation-chip"][data-relation="mentions"]'),
      'click',
    );
    expect(el.querySelector('[data-testid="atlas-authored-arc"]')).toBeNull();
  });

  it('shows the edge readout in the fixed side panel on hover', async () => {
    const el = await mount(makeGraph());
    const hit = el.querySelector(
      '[data-testid="atlas-edge-hit"][data-from="health_vital"][data-to="core_observation"]',
    );
    await fire(hit, 'mouseover');
    const readout = el.querySelector('[data-testid="atlas-readout"]');
    expect(readout?.textContent).toContain('core_observation');
    expect(readout?.textContent).toContain('41,230');
  });
});
