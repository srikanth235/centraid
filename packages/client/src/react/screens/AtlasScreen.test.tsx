import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import AtlasScreen, { type AtlasScreenProps } from './AtlasScreen.js';
import type {
  AtlasCensusPayload,
  AtlasGraphPayload,
  AtlasPulsePayload,
} from '../../gateway-client.js';

// The Browse tab (mounted when a Kinds card is clicked) self-fetches through the
// vault client. Stub those helpers so the openBrowse seam can be exercised here
// without a live gateway; Browse's own behaviour is covered in
// AtlasBrowseTab.test.tsx. vitest hoists this mock above the imports above.
vi.mock('../../gateway-client.js', () => ({
  browseTables: () =>
    Promise.resolve([
      {
        logical: 'core.party',
        physical: 'core_party',
        pack: 'core',
        packLabel: 'Core',
        packKind: 'ontology',
        label: 'Party',
        rows: 214,
        machinery: false,
        singlePk: true,
      },
    ]),
  browseColumns: () =>
    Promise.resolve({
      logical: 'core.party',
      physical: 'core_party',
      keysetKey: 'party_id',
      displayField: 'display_name',
      machinery: false,
      columns: [
        {
          name: 'party_id',
          type: 'TEXT',
          notnull: true,
          pk: 1,
          defaultValue: null,
          fkTable: null,
          fkColumn: null,
          fkLogical: null,
          sealed: false,
        },
      ],
    }),
  browseRows: () =>
    Promise.resolve({
      logical: 'core.party',
      physical: 'core_party',
      rows: [],
      columns: ['party_id'],
      nextCursor: null,
      orderBy: 'party_id',
      dir: 'asc',
      keysetKey: 'party_id',
    }),
  browseRow: () => Promise.resolve({ logical: '', physical: '', row: {}, columns: [] }),
  browseRefSearch: () => Promise.resolve([]),
  browseDependents: () =>
    Promise.resolve({
      logical: '',
      physical: '',
      id: '',
      dependents: [],
      hasEngineDependents: false,
      totalRows: 0,
    }),
  browseInsertRow: () => Promise.resolve({ ok: true }),
  browseUpdateRow: () => Promise.resolve({ ok: true }),
  browseDeleteRow: () => Promise.resolve({ ok: true }),
}));

const GENERATED_AT = '2026-07-17T12:00:00.000Z';
const SINCE = '2026-06-17T12:00:00.000Z';

function makeStats(over: Partial<AtlasCensusPayload> = {}): AtlasCensusPayload {
  return {
    generatedAt: GENERATED_AT,
    method: 'dbstat',
    fileBytesTotal: 4_400_000_000,
    packs: [
      {
        pack: 'core',
        packLabel: 'Core',
        packKind: 'ontology',
        file: 'vault',
        rows: 214,
        bytes: 3_000_000,
        tables: [
          {
            logical: 'core.party',
            physical: 'core_party',
            table: 'party',
            label: 'Party',
            rows: 214,
            bytes: 2_000_000,
            pages: 40,
          },
          {
            logical: 'core.place',
            physical: 'core_place',
            table: 'place',
            label: 'Place',
            rows: 0,
            bytes: 0,
            pages: 0,
          },
        ],
      },
      {
        pack: 'consent',
        packLabel: 'Consent',
        packKind: 'machinery',
        file: 'vault',
        rows: 12,
        bytes: 40_000,
        tables: [
          {
            logical: 'consent.share',
            physical: 'consent_share',
            table: 'share',
            label: 'Share',
            rows: 12,
            bytes: 40_000,
            pages: 2,
          },
        ],
      },
    ],
    totals: { rows: 226, bytes: 3_040_000, kinds: 3, populatedKinds: 2 },
    ...over,
  };
}

function makePulse(): AtlasPulsePayload {
  return {
    generatedAt: GENERATED_AT,
    since: SINCE,
    windowDays: 30,
    live: true,
    series: [
      {
        entityType: 'core.party',
        physical: 'core_party',
        pack: 'core',
        label: 'Party',
        total: 9,
        days: [{ day: '2026-07-10', count: 9 }],
      },
    ],
  };
}

function makeGraph(): AtlasGraphPayload {
  return {
    generatedAt: GENERATED_AT,
    center: 'core_party',
    nodes: [],
    fkEdges: [],
    authoredLinks: [],
    island: [],
    edgeCount: 0,
    centerEdgeCount: 0,
    selfRefCount: 0,
  };
}

function makeProps(over: Partial<AtlasScreenProps> = {}): AtlasScreenProps {
  return {
    loadStats: vi.fn().mockResolvedValue(makeStats()),
    loadPulse: vi.fn().mockResolvedValue(makePulse()),
    loadGraph: vi.fn().mockResolvedValue(makeGraph()),
    ...over,
  };
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  vi.restoreAllMocks();
});

async function mount(props: AtlasScreenProps): Promise<HTMLDivElement> {
  container = document.createElement('div');
  document.body.appendChild(container);
  await act(async () => {
    root = createRoot(container as HTMLDivElement);
    root.render(<AtlasScreen {...props} />);
  });
  // Let the mount-time census/pulse/graph promises settle.
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  return container;
}

const cardByLogical = (el: HTMLElement, logical: string): HTMLElement | null =>
  el.querySelector<HTMLElement>(`[data-testid="atlas-kind-card"][data-logical="${logical}"]`);

const click = async (node: Element | null | undefined): Promise<void> => {
  await act(async () => node?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  await act(async () => {
    await Promise.resolve();
  });
};

describe('AtlasScreen — Kinds census', () => {
  it('renders the census sentence from the stats payload', async () => {
    const el = await mount(makeProps());
    expect(el.textContent).toContain('Your vault knows');
    expect(el.textContent).toContain('214');
    expect(el.textContent).toContain('parties'); // ontology-vocabulary plural of "Party"
    expect(el.textContent).toContain('2 of 3 kinds'); // populatedKinds of kinds
  });

  it('renders a dashed ghost card for a zero-row kind', async () => {
    const el = await mount(makeProps());
    const ghost = el.querySelector<HTMLElement>(
      '[data-testid="atlas-kind-card"][data-empty="true"]',
    );
    expect(ghost).toBeTruthy();
    expect(ghost?.dataset.logical).toBe('core.place');
    expect(ghost?.textContent).toContain('Place');
    expect(ghost?.textContent).toContain('never written');
  });

  it('the Rows/Bytes toggle switches a populated card between its count and size', async () => {
    const el = await mount(makeProps());
    const value = () =>
      cardByLogical(el, 'core.party')?.querySelector('[data-testid="atlas-kind-value"]')
        ?.textContent;
    expect(value()).toBe('214');

    const bytesBtn = [...el.querySelectorAll('button')].find((b) => b.textContent === 'Bytes');
    await click(bytesBtn);
    expect(value()).toContain('MB'); // 2,000,000 B → "1.9 MB"
    expect(value()).not.toBe('214');
  });

  it('keeps the machinery shelf collapsed by default, expandable on click', async () => {
    const el = await mount(makeProps());
    expect(el.querySelector('[data-testid="atlas-machinery-table"]')).toBeNull();
    const toggle = el.querySelector('[data-testid="atlas-machinery-toggle"]');
    expect(toggle).toBeTruthy();
    await click(toggle);
    const table = el.querySelector('[data-testid="atlas-machinery-table"]');
    expect(table).toBeTruthy();
    expect(table?.textContent).toContain('Share'); // the consent machinery kind
  });

  it('a kind-card click opens Browse preselected to that kind (openBrowse seam)', async () => {
    const el = await mount(makeProps());
    await click(cardByLogical(el, 'core.party'));
    // Let the Browse tab's tables/columns/rows fetches settle.
    for (let i = 0; i < 6; i += 1) {
      // eslint-disable-next-line no-await-in-loop -- (#441) sequential microtask drain
      await act(async () => {
        await Promise.resolve();
      });
    }
    // Screen switched to the Browse tab, preselected to the clicked kind — the
    // editor header echoes the logical name and its insert control is present.
    expect(el.querySelector('[data-testid="atlas-browse-insert"]')).toBeTruthy();
    expect(el.textContent).toContain('core.party');
  });
});

describe('AtlasScreen — census failure', () => {
  it('surfaces a stats-load error instead of the census', async () => {
    const el = await mount(
      makeProps({ loadStats: vi.fn().mockRejectedValue(new Error('vault offline')) }),
    );
    const err = el.querySelector('[data-testid="atlas-census-error"]');
    expect(err?.textContent).toContain('vault offline');
  });
});
