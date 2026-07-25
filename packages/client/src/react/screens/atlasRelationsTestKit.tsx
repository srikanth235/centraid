import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import AtlasRelationsTab, { type AtlasRelationsTabProps } from './AtlasRelationsTab.js';
import type {
  AtlasCensusPack,
  AtlasCensusPayload,
  AtlasCensusTable,
  AtlasFkEdge,
  AtlasGraphNode,
  AtlasGraphPayload,
} from '../../gateway-client.js';

// Shared test kit for the Map suites (issue #519 follow-on). Fixtures, the mount
// harness, and the DOM query helpers live here so the pure-geometry suite
// (atlasSunburstGeometry.test) and the component suite (AtlasRelationsTab.test)
// share one payload and one set of selectors.
//
// The fixture is built around the case the redesign exists to fix: `locker` is a
// domain whose every kind holds ZERO rows, and `business` is an empty domain the
// graph payload does not mention at all. Under the old detail dial both vanished
// from the chart while keeping their names on the bezel. Every suite here asserts
// they are present AND selectable.

// ── Graph fixture (curated names + FK edges) ──────────────────────────────
export const node = (
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

export const edge = (
  fromTable: string,
  col: string,
  toTable: string,
  over: Partial<AtlasFkEdge> = {},
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

export function makeGraph(over: Partial<AtlasGraphPayload> = {}): AtlasGraphPayload {
  const nodes: AtlasGraphNode[] = [
    node('core_party', 'core', 'ontology', {
      friendly: 'People',
      blurb: 'Everyone your vault knows about.',
    }),
    node('core_observation', 'core', 'ontology', {
      friendly: 'Observations',
      blurb: 'Point-in-time readings and notes.',
    }),
    node('core_concept', 'core', 'ontology', { selfRef: true }),
    node('health_vital', 'health', 'ontology', { friendly: 'Vitals' }),
    node('knowledge_note', 'knowledge', 'ontology'),
    node('consent_device', 'consent', 'machinery'),
    // an EMPTY kind that is nevertheless genuinely connected
    node('locker_item', 'locker', 'ontology', { friendly: 'Secrets' }),
    node('sync_connection', 'sync', 'machinery'),
  ];
  const fkEdges: AtlasFkEdge[] = [
    edge('health_vital', 'observation_id', 'core_observation', { childRows: 41230, fill: 41230 }),
    edge('core_observation', 'subject_party_id', 'core_party', { childRows: 44902, fill: 44902 }),
    edge('core_observation', 'device_id', 'consent_device', {
      notnull: false,
      childRows: 44902,
      fill: 44000,
    }),
    edge('knowledge_note', 'author_party_id', 'core_party', { childRows: 742, fill: 742 }),
    edge('knowledge_note', 'topic_concept_id', 'core_concept', {
      notnull: false,
      childRows: 742,
      fill: 520,
    }),
    // self-reference — never a neighbour of itself
    edge('core_concept', 'broader_concept_id', 'core_concept', {
      notnull: false,
      childRows: 342,
      fill: 297,
      selfRef: true,
    }),
    // the empty locker kind still declares two real joins: one into ontology,
    // one into machinery (the cross-plumbing hop the tab has to handle)
    edge('locker_item', 'owner_party_id', 'core_party', { ghost: true }),
    edge('locker_item', 'connection_id', 'sync_connection', { ghost: true }),
  ];
  return {
    generatedAt: '2026-07-17T12:00:00.000Z',
    center: 'core_party',
    nodes,
    fkEdges,
    authoredLinks: [],
    island: ['locker_item', 'sync_connection'],
    edgeCount: fkEdges.length,
    centerEdgeCount: fkEdges.filter((e) => e.toTable === 'core_party').length,
    selfRefCount: 1,
    ...over,
  };
}

// ── Census fixture (the hierarchy + every exact row count) ─────────────────
const table = (pack: string, name: string, rows: number): AtlasCensusTable => ({
  logical: `${pack}.${name}`,
  physical: `${pack}_${name}`,
  table: name,
  label: name.replace(/_/g, ' '),
  rows,
  bytes: null,
  pages: null,
});

const pack = (
  name: string,
  packKind: 'ontology' | 'machinery',
  tables: AtlasCensusTable[],
): AtlasCensusPack => ({
  pack: name,
  packLabel: (name[0]?.toUpperCase() ?? '') + name.slice(1),
  packKind,
  file: 'vault',
  tables,
  rows: tables.reduce((s, t) => s + t.rows, 0),
  bytes: null,
});

/** Four ontology domains with data, TWO entirely empty ones, two machinery
 *  bands. `locker` holds a single empty kind — the exact shape that used to
 *  become an unclickable 4° sliver. */
export function makeStats(over: Partial<AtlasCensusPayload> = {}): AtlasCensusPayload {
  const packs: AtlasCensusPack[] = [
    pack('core', 'ontology', [
      table('core', 'party', 214),
      table('core', 'observation', 44902),
      table('core', 'concept', 342),
    ]),
    pack('health', 'ontology', [table('health', 'vital', 41230)]),
    pack('knowledge', 'ontology', [table('knowledge', 'note', 742)]),
    pack('locker', 'ontology', [table('locker', 'item', 0)]),
    // an empty domain the graph payload never mentions — census-only path
    pack('business', 'ontology', [table('business', 'client', 0), table('business', 'invoice', 0)]),
    pack('consent', 'machinery', [table('consent', 'device', 12)]),
    pack('sync', 'machinery', [table('sync', 'connection', 63)]),
  ];
  const rows = packs.reduce((s, p) => s + p.rows, 0);
  const kinds = packs.reduce((s, p) => s + p.tables.length, 0);
  return {
    generatedAt: '2026-07-17T12:00:00.000Z',
    method: 'estimate',
    fileBytesTotal: 4096,
    packs,
    totals: {
      rows,
      bytes: null,
      kinds,
      populatedKinds: packs.reduce((s, p) => s + p.tables.filter((t) => t.rows > 0).length, 0),
    },
    ...over,
  };
}

// ── Mount harness ─────────────────────────────────────────────────────────
let root: Root | null = null;
let container: HTMLDivElement | null = null;

/** Tear down the mounted tree — call from each suite's `afterEach`. */
export function cleanupTab(): void {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
}

export async function mountTab(
  stats: AtlasCensusPayload | null,
  props: Partial<AtlasRelationsTabProps> = {},
): Promise<HTMLDivElement> {
  container = document.createElement('div');
  document.body.appendChild(container);
  await act(async () => {
    root = createRoot(container as HTMLDivElement);
    root.render(
      <AtlasRelationsTab
        stats={stats}
        graph={makeGraph()}
        onOpenBrowse={() => undefined}
        {...props}
      />,
    );
  });
  await act(async () => {
    await Promise.resolve();
  });
  return container;
}

// Drain a few microtask turns so an injected async fetcher's `.then` settles and
// its state update re-renders. A fixed unrolled sequence — four is enough.
export const flush = async (): Promise<void> => {
  const turn = async (): Promise<void> => {
    await act(async () => {
      await Promise.resolve();
    });
  };
  await turn();
  await turn();
  await turn();
  await turn();
};

export const fire = async (el: Element | null | undefined, type: string): Promise<void> => {
  await act(async () => el?.dispatchEvent(new MouseEvent(type, { bubbles: true })));
  await act(async () => {
    await Promise.resolve();
  });
};

/** Every wedge id currently on the ring, in draw order. */
export const wedgeIds = (el: HTMLElement): string[] =>
  [...el.querySelectorAll<SVGElement>('[data-testid="atlas-wedge"]')].map(
    (w) => w.dataset['id'] ?? '',
  );

export const wedge = (el: HTMLElement, id: string): SVGElement | null =>
  el.querySelector<SVGElement>(`[data-testid="atlas-wedge"][data-id="${id}"]`);

/** Every index row id — the text half of the same rung. */
export const indexIds = (el: HTMLElement): string[] =>
  [...el.querySelectorAll<HTMLElement>('[data-testid="atlas-index-row"]')].map(
    (r) => r.dataset['id'] ?? '',
  );

export const indexRow = (el: HTMLElement, id: string): HTMLElement | null =>
  el.querySelector<HTMLElement>(`[data-testid="atlas-index-row"][data-id="${id}"]`);

export const bezelPacks = (el: HTMLElement): string[] =>
  [...el.querySelectorAll<SVGElement>('[data-testid="atlas-bezel"]')].map(
    (b) => b.dataset['pack'] ?? '',
  );

export const focusOf = (el: HTMLElement): string | undefined =>
  el.querySelector<SVGElement>('[data-testid="atlas-sunburst"]')?.dataset['focus'];

export const detailLogical = (el: HTMLElement): string | undefined =>
  el.querySelector<HTMLElement>('[data-testid="atlas-detail"]')?.dataset['logical'];

export const captionText = (el: HTMLElement): string =>
  el.querySelector('[data-testid="atlas-caption"]')?.textContent ?? '';
