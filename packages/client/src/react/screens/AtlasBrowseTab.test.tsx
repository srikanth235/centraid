import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AtlasBrowseTab from './AtlasBrowseTab.js';

// The Browse tab self-fetches through the vault client (its only prop is the
// preselected table), so the client module is mocked wholesale and each helper
// resolves from a per-test vi.fn. vitest hoists this above the import above.
vi.mock('../../gateway-client.js', () => ({
  browseTables: (...a: unknown[]) => browseTablesMock(...a),
  browseColumns: (...a: unknown[]) => browseColumnsMock(...a),
  browseRows: (...a: unknown[]) => browseRowsMock(...a),
  browseRow: (...a: unknown[]) => browseRowMock(...a),
  browseRefSearch: (...a: unknown[]) => browseRefSearchMock(...a),
  browseDependents: (...a: unknown[]) => browseDependentsMock(...a),
  browseInsertRow: (...a: unknown[]) => browseInsertRowMock(...a),
  browseUpdateRow: (...a: unknown[]) => browseUpdateRowMock(...a),
  browseDeleteRow: (...a: unknown[]) => browseDeleteRowMock(...a),
}));

const browseTablesMock = vi.fn();
const browseColumnsMock = vi.fn();
const browseRowsMock = vi.fn();
const browseRowMock = vi.fn();
const browseRefSearchMock = vi.fn();
const browseDependentsMock = vi.fn();
const browseInsertRowMock = vi.fn();
const browseUpdateRowMock = vi.fn();
const browseDeleteRowMock = vi.fn();

const SEALED = '«sealed»'; // «sealed»

const col = (name: string, over: Record<string, unknown> = {}) => ({
  name,
  type: 'TEXT',
  notnull: false,
  pk: 0,
  defaultValue: null,
  fkTable: null,
  fkColumn: null,
  fkLogical: null,
  sealed: false,
  ...over,
});

const TABLES = [
  {
    logical: 'core.party',
    physical: 'core_party',
    pack: 'core',
    packLabel: 'Core',
    packKind: 'ontology' as const,
    label: 'Party',
    rows: 214,
    machinery: false,
    singlePk: true,
  },
  {
    logical: 'knowledge.note',
    physical: 'knowledge_note',
    pack: 'knowledge',
    packLabel: 'Knowledge',
    packKind: 'ontology' as const,
    label: 'Note',
    rows: 88,
    machinery: false,
    singlePk: true,
  },
  {
    logical: 'journal.segment',
    physical: 'journal_segment',
    pack: 'journal',
    packLabel: 'Journal',
    packKind: 'machinery' as const,
    label: 'Segment',
    rows: 4021,
    machinery: true,
    singlePk: true,
  },
];

const PARTY_COLS = {
  logical: 'core.party',
  physical: 'core_party',
  keysetKey: 'party_id',
  displayField: 'display_name',
  machinery: false,
  columns: [
    col('party_id', { pk: 1, notnull: true }),
    col('display_name', { notnull: true }),
    col('home_place_id', { fkTable: 'core_place', fkColumn: 'place_id', fkLogical: 'core.place' }),
    col('secret', { sealed: true }),
  ],
};

const MACHINERY_COLS = {
  logical: 'journal.segment',
  physical: 'journal_segment',
  keysetKey: 'seq',
  displayField: 'seq',
  machinery: true,
  columns: [col('seq', { type: 'INTEGER', pk: 1, notnull: true }), col('note')],
};

const partyRow = (id: string, name: string, place: string | null) => ({
  party_id: id,
  display_name: name,
  home_place_id: place,
  secret: SEALED,
});

const partyPage = (rows: Record<string, unknown>[], nextCursor: string | null) => ({
  logical: 'core.party',
  physical: 'core_party',
  rows,
  columns: ['party_id', 'display_name', 'home_place_id', 'secret'],
  nextCursor,
  orderBy: 'party_id',
  dir: 'asc' as const,
  keysetKey: 'party_id',
});

beforeEach(() => {
  vi.clearAllMocks();
  browseTablesMock.mockResolvedValue(TABLES);
  browseColumnsMock.mockImplementation((t: string) =>
    Promise.resolve(t === 'journal.segment' ? MACHINERY_COLS : PARTY_COLS),
  );
  browseRowsMock.mockImplementation(({ table }: { table: string }) =>
    Promise.resolve(
      table === 'journal.segment'
        ? {
            logical: 'journal.segment',
            physical: 'journal_segment',
            rows: [{ seq: 1, note: 'boot' }],
            columns: ['seq', 'note'],
            nextCursor: null,
            orderBy: 'seq',
            dir: 'asc',
            keysetKey: 'seq',
          }
        : partyPage([partyRow('p1', 'Alice', 'place-1'), partyRow('p2', 'Bob', null)], null),
    ),
  );
  browseRefSearchMock.mockResolvedValue([{ id: 'place-1', display: 'Alice’s Home' }]);
  browseDependentsMock.mockResolvedValue({
    logical: 'core.party',
    physical: 'core_party',
    id: 'p1',
    dependents: [],
    hasEngineDependents: false,
    totalRows: 0,
  });
  browseInsertRowMock.mockResolvedValue({ ok: true, id: 'new-1' });
  browseUpdateRowMock.mockResolvedValue({ ok: true, id: 'p1' });
  browseDeleteRowMock.mockResolvedValue({ ok: true, id: 'p1' });
});

let root: Root | null = null;
let container: HTMLDivElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
});

async function settle(n = 6): Promise<void> {
  for (let i = 0; i < n; i += 1) {
    // eslint-disable-next-line no-await-in-loop -- (#441) deliberate sequential microtask drain
    await act(async () => {
      await Promise.resolve();
    });
  }
}

async function mount(initialTable?: string): Promise<HTMLDivElement> {
  container = document.createElement('div');
  document.body.appendChild(container);
  await act(async () => {
    root = createRoot(container as HTMLDivElement);
    root.render(<AtlasBrowseTab initialTable={initialTable} />);
  });
  await settle();
  return container;
}

const click = async (node: Element | null | undefined): Promise<void> => {
  await act(async () => node?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  await settle(3);
};

function typeInto(input: Element | null, value: string): void {
  const el = input as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
  setter?.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

const type = async (input: Element | null, value: string): Promise<void> => {
  await act(async () => typeInto(input, value));
  await settle(3);
};

const submitForm = async (form: Element | null): Promise<void> => {
  await act(async () =>
    form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
  );
  await settle(3);
};

const $ = (el: HTMLElement, sel: string) => el.querySelector<HTMLElement>(sel);
const $$ = (el: HTMLElement, sel: string) => [...el.querySelectorAll<HTMLElement>(sel)];

describe('AtlasBrowseTab — table picker', () => {
  it('groups ontology packs before machinery bands and preselects initialTable', async () => {
    const el = await mount('core.party');
    const opts = $$(el, '[data-testid="atlas-browse-table-option"]');
    const kinds = opts.map((o) => o.dataset.packKind);
    const firstMachinery = kinds.indexOf('machinery');
    expect(firstMachinery).toBeGreaterThan(0);
    // every option before the first machinery option is ontology
    expect(kinds.slice(0, firstMachinery).every((k) => k === 'ontology')).toBe(true);
    // the divider sits between the two bands
    expect($(el, '[data-testid="atlas-browse-machinery-divider"]')).toBeTruthy();

    // preselected: core.party is the active option and drives the header
    const active = opts.find((o) => o.dataset.logical === 'core.party');
    expect(active?.getAttribute('aria-selected')).toBe('true');
    expect(el.textContent).toContain('core.party');
  });

  it('reacts to initialTable changing while mounted', async () => {
    const el = await mount('core.party');
    expect(el.textContent).toContain('core.party');
    await act(async () => {
      root?.render(<AtlasBrowseTab initialTable="knowledge.note" />);
    });
    await settle();
    expect(el.textContent).toContain('knowledge.note');
  });
});

describe('AtlasBrowseTab — grid', () => {
  it('renders rows and appends the next keyset page on Load more', async () => {
    browseRowsMock
      .mockResolvedValueOnce(partyPage([partyRow('p1', 'Alice', 'place-1')], 'cursor-1'))
      .mockResolvedValueOnce(partyPage([partyRow('p2', 'Bob', null)], null));

    const el = await mount('core.party');
    expect($$(el, '[data-testid="atlas-browse-row"]')).toHaveLength(1);

    const more = $(el, '[data-testid="atlas-browse-load-more"]');
    expect(more).toBeTruthy();
    await click(more);

    // the second call carried the prior nextCursor as `after` (keyset, no OFFSET)
    const secondCall = browseRowsMock.mock.calls.at(-1)?.[0];
    expect(secondCall.after).toBe('cursor-1');
    expect($$(el, '[data-testid="atlas-browse-row"]')).toHaveLength(2);
  });

  it('round-trips orderBy when a column header is clicked', async () => {
    const el = await mount('core.party');
    const header = $(el, '[data-testid="atlas-browse-col"][data-col="display_name"]');
    await click(header);
    const lastCall = browseRowsMock.mock.calls.at(-1)?.[0];
    expect(lastCall.orderBy).toBe('display_name');
    expect(lastCall.dir).toBe('asc');
  });

  it('renders a sealed cell as a chip, never the masked plaintext', async () => {
    const el = await mount('core.party');
    expect($(el, '[data-testid="atlas-sealed-chip"]')).toBeTruthy();
    const grid = $(el, '[data-testid="atlas-browse-grid"]');
    expect(grid?.textContent).not.toContain(SEALED);
    expect(grid?.textContent).toContain('sealed');
  });
});

describe('AtlasBrowseTab — row editor', () => {
  it('updates only edited, non-primary, unsealed fields through browseUpdateRow', async () => {
    const el = await mount('core.party');
    const row = $(el, '[data-testid="atlas-browse-row"][data-id="p1"]');
    await click($(row!, '[data-testid="atlas-row-edit"]'));

    await type($(el, '[data-testid="atlas-field"][data-col="display_name"]'), 'Alice Cooper');
    await submitForm($(el, '[data-testid="atlas-row-editor"]'));

    expect(browseUpdateRowMock).toHaveBeenCalledTimes(1);
    expect(browseUpdateRowMock).toHaveBeenCalledWith({
      table: 'core.party',
      id: 'p1',
      set: { display_name: 'Alice Cooper' },
    });
  });

  it('FK field searches the target table and stores the picked id', async () => {
    const el = await mount('core.party');
    await click($(el, '[data-testid="atlas-browse-insert"]'));
    expect($(el, '[data-testid="atlas-row-editor"]')).toBeTruthy();

    const fk = $(el, '[data-testid="atlas-fk-input"][data-col="home_place_id"]');
    await type(fk, 'ali');
    expect(browseRefSearchMock).toHaveBeenCalledWith('core_place', 'ali');

    const hit = $(el, '[data-testid="atlas-fk-hit"][data-id="place-1"]');
    expect(hit).toBeTruthy();
    await click(hit);

    await type($(el, '[data-testid="atlas-field"][data-col="display_name"]'), 'Carol');
    await submitForm($(el, '[data-testid="atlas-row-editor"]'));

    expect(browseInsertRowMock).toHaveBeenCalledTimes(1);
    const arg = browseInsertRowMock.mock.calls[0]?.[0];
    expect(arg?.table).toBe('core.party');
    expect(arg?.values.home_place_id).toBe('place-1'); // the picked id, not the typed text
    expect(arg?.values.display_name).toBe('Carol');
    expect(arg?.values.secret).toBeUndefined(); // sealed column never written
  });

  it('surfaces a 400 write error inline instead of throwing', async () => {
    browseInsertRowMock.mockResolvedValue({
      ok: false,
      error: 'NOT NULL constraint failed: core_party.display_name',
    });
    const el = await mount('core.party');
    await click($(el, '[data-testid="atlas-browse-insert"]'));
    await type($(el, '[data-testid="atlas-field"][data-col="display_name"]'), 'x');
    await submitForm($(el, '[data-testid="atlas-row-editor"]'));

    const err = $(el, '[data-testid="atlas-row-error"]');
    expect(err?.textContent).toContain('NOT NULL constraint failed');
    // editor stays open on failure
    expect($(el, '[data-testid="atlas-row-editor"]')).toBeTruthy();
  });
});

describe('AtlasBrowseTab — delete flow', () => {
  it('lists dependents with counts and blocks when engine FKs point at the row', async () => {
    browseDependentsMock.mockResolvedValue({
      logical: 'core.party',
      physical: 'core_party',
      id: 'p1',
      dependents: [
        { table: 'knowledge_note', via: 'author_party_id', count: 12, mechanism: 'fk' },
        { table: 'core_tag', via: 'target_id', count: 3, mechanism: 'poly' },
      ],
      hasEngineDependents: true,
      totalRows: 15,
    });

    const el = await mount('core.party');
    const row = $(el, '[data-testid="atlas-browse-row"][data-id="p1"]');
    await click($(row!, '[data-testid="atlas-row-delete"]'));

    expect(browseDependentsMock).toHaveBeenCalledWith('core.party', 'p1');
    const dialog = $(el, '[data-testid="atlas-delete-dialog"]');
    expect(dialog).toBeTruthy();
    expect($(el, '[data-testid="atlas-delete-summary"]')?.textContent).toContain(
      '2 tables reference this row (15 rows)',
    );

    const deps = $$(el, '[data-testid="atlas-dependent"]');
    expect(deps.map((d) => d.dataset.mechanism)).toEqual(['fk', 'poly']);
    // blocked: engine FKs present → confirm disabled + explanation shown
    expect($(el, '[data-testid="atlas-delete-blocked"]')).toBeTruthy();
    expect(($(el, '[data-testid="atlas-delete-confirm"]') as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(browseDeleteRowMock).not.toHaveBeenCalled();
  });

  it('allows a delete when only polymorphic dependents exist', async () => {
    browseDependentsMock.mockResolvedValue({
      logical: 'core.party',
      physical: 'core_party',
      id: 'p1',
      dependents: [{ table: 'core_tag', via: 'target_id', count: 3, mechanism: 'poly' }],
      hasEngineDependents: false,
      totalRows: 3,
    });
    const el = await mount('core.party');
    const row = $(el, '[data-testid="atlas-browse-row"][data-id="p1"]');
    await click($(row!, '[data-testid="atlas-row-delete"]'));

    expect($(el, '[data-testid="atlas-delete-warn"]')).toBeTruthy();
    const confirm = $(el, '[data-testid="atlas-delete-confirm"]') as HTMLButtonElement;
    expect(confirm.disabled).toBe(false);
    await click(confirm);
    expect(browseDeleteRowMock).toHaveBeenCalledWith({ table: 'core.party', id: 'p1' });
  });
});

describe('AtlasBrowseTab — machinery', () => {
  it('locks the editor for a machinery table until the unlock is toggled', async () => {
    const el = await mount('journal.segment');
    expect($(el, '[data-testid="atlas-machinery-locked"]')).toBeTruthy();
    const insert = $(el, '[data-testid="atlas-browse-insert"]') as HTMLButtonElement;
    expect(insert.disabled).toBe(true);

    await click($(el, '[data-testid="atlas-machinery-unlock"]'));
    expect(($(el, '[data-testid="atlas-browse-insert"]') as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  it('rides unlockMachinery on a write once unlocked', async () => {
    const el = await mount('journal.segment');
    await click($(el, '[data-testid="atlas-machinery-unlock"]'));
    await click($(el, '[data-testid="atlas-browse-insert"]'));
    await type($(el, '[data-testid="atlas-field"][data-col="note"]'), 'hand edit');
    await submitForm($(el, '[data-testid="atlas-row-editor"]'));

    expect(browseInsertRowMock).toHaveBeenCalledTimes(1);
    expect(browseInsertRowMock.mock.calls[0]?.[0]?.unlockMachinery).toBe(true);
  });
});
