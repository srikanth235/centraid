import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import AtlasRelationsTab, { type AtlasRelationsTabProps } from './AtlasRelationsTab.js';
import type { AtlasDetailLevel } from './atlasOrreryGeometry.js';
import type { AtlasFkEdge, AtlasGraphNode, AtlasGraphPayload } from '../../gateway-client.js';

// Shared test kit for the Relations "Map" suites (issue #519). Fixtures, the
// mount harness, and the DOM query helpers live here so the pure-geometry suite
// (atlasOrreryGeometry.test) and the component suite (AtlasRelationsTab.test)
// share one payload and one set of selectors — and neither file grows unwieldy.

// ── Sample payload ────────────────────────────────────────────────────────
// A slice of the real vault graph: core_party at the hub, a health/observation
// chain (the readout example), a self-referencing concept, one ghost edge, and
// the genuinely-disconnected locker/sync island.
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

export function makeGraph(over: Partial<AtlasGraphPayload> = {}): AtlasGraphPayload {
  const nodes: AtlasGraphNode[] = [
    // friendly/blurb are optional on the type — set only where a test reads them
    // (the human-language layer: People over core_party, a curated blurb, etc.)
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

/** Tear down the mounted tree — call from each suite's `afterEach`. */
export function cleanupTab(): void {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
}

export async function mountTab(
  graph: AtlasGraphPayload | null,
  props: Partial<AtlasRelationsTabProps> = {},
): Promise<HTMLDivElement> {
  container = document.createElement('div');
  document.body.appendChild(container);
  await act(async () => {
    root = createRoot(container as HTMLDivElement);
    root.render(<AtlasRelationsTab graph={graph} {...props} />);
  });
  await act(async () => {
    await Promise.resolve();
  });
  return container;
}

// Drain a few microtask turns so an injected async fetcher's `.then` settles and
// its state update re-renders (the sample-rows fetch resolves off the mount). A
// fixed unrolled sequence — four sequential turns is enough for the chain.
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

export const fire = async (node: Element | null | undefined, type: string): Promise<void> => {
  await act(async () => node?.dispatchEvent(new MouseEvent(type, { bubbles: true })));
  await act(async () => {
    await Promise.resolve();
  });
};

export const nodeEl = (el: HTMLElement, physical: string): HTMLElement | null =>
  el.querySelector<HTMLElement>(`[data-testid="atlas-node"][data-physical="${physical}"]`);

// The detail dial defaults to `simple`; several facts are true only at
// `standard` (reachable machinery, ghost edges, the full island). Click a dial
// segment to switch the lens — it never resets the centre or camera.
export const setLevel = async (el: HTMLElement, level: AtlasDetailLevel): Promise<void> =>
  fire(el.querySelector(`[data-testid="atlas-detail-dial"] [data-level="${level}"]`), 'click');

/** The dial position currently pressed (which segment has aria-pressed=true). */
export const dialLevel = (el: HTMLElement): string | undefined =>
  el.querySelector<HTMLElement>('[data-testid="atlas-detail-dial"] [aria-pressed="true"]')?.dataset
    .level ?? undefined;

export const orreryCenter = (el: HTMLElement): string | undefined =>
  el.querySelector<SVGElement>('[data-testid="atlas-orrery"]')?.dataset.center;

export const viewportTransform = (el: HTMLElement): string =>
  el.querySelector('[data-testid="atlas-viewport"]')?.getAttribute('transform') ?? '';

export const scaleOf = (el: HTMLElement): number => {
  const m = /scale\(([-\d.]+)\)/.exec(viewportTransform(el));
  return m?.[1] !== undefined ? parseFloat(m[1]) : Number.NaN;
};
