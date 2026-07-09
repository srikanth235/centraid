import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ImportBridgeProps, ImportData } from '../bridge.js';
import ImportScreen from './ImportScreen.js';

const dataWithDraft: ImportData = {
  vaultName: 'home',
  connections: [
    {
      connectionId: 'c1',
      kind: 'gmail',
      label: 'Gmail',
      principal: 'me@x.com',
      status: 'active',
      lastRunAt: null,
      lastRunError: null,
    },
    // file.* connections are filtered out
    {
      connectionId: 'f1',
      kind: 'file.csv',
      label: 'A CSV',
      principal: null,
      status: 'active',
      lastRunAt: null,
      lastRunError: null,
    },
  ],
  batches: [
    {
      batchId: 'b1',
      status: 'draft',
      createdAt: '2026-07-01T00:00:00.000Z',
      summary: { create: 3, skip: 1 },
      kind: 'ics',
      label: 'Calendar',
    },
    {
      batchId: 'b0',
      status: 'published',
      createdAt: '2026-06-01T00:00:00.000Z',
      summary: { created: 5 },
      kind: 'vcf',
      label: 'Contacts',
    },
  ],
};

function makeProps(over: Partial<ImportBridgeProps> = {}): ImportBridgeProps {
  return {
    loadData: vi.fn().mockResolvedValue(dataWithDraft),
    stage: vi.fn().mockResolvedValue(3),
    loadRows: vi.fn().mockResolvedValue([
      { entityType: 'event', externalId: 'e1', disposition: 'create', note: null },
      { entityType: 'event', externalId: 'e2', disposition: 'skip', note: 'dup' },
    ]),
    publish: vi.fn().mockResolvedValue(undefined),
    discard: vi.fn().mockResolvedValue(undefined),
    setConnectionStatus: vi.fn().mockResolvedValue(undefined),
    showToast: vi.fn(),
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
  vi.clearAllMocks();
});
async function mount(props: ImportBridgeProps): Promise<HTMLDivElement> {
  container = document.createElement('div');
  document.body.appendChild(container);
  await act(async () => {
    root = createRoot(container as HTMLDivElement);
    root.render(<ImportScreen {...props} />);
  });
  // let the DraftSection row-load effect settle
  await act(async () => {
    await Promise.resolve();
  });
  return container;
}

describe('ImportScreen', () => {
  it('renders the drop zone, live connections (file.* filtered), draft + history', async () => {
    const el = await mount(makeProps());
    expect(el.textContent).toContain('Import into · home');
    expect(el.querySelector('.file')).toBeTruthy();
    // live connection shown, file.* hidden
    expect(el.textContent).toContain('Gmail · gmail');
    expect(el.textContent).not.toContain('file.csv');
    // draft with its summary + loaded rows
    expect(el.textContent).toContain('Draft · Calendar');
    expect(el.textContent).toContain('3 create · 1 skip');
    expect(el.querySelectorAll('.row').length).toBe(2);
    // history
    expect(el.textContent).toContain('History');
    expect(el.textContent).toContain('Contacts');
  });

  it('publishes a draft then reloads', async () => {
    const props = makeProps();
    const el = await mount(props);
    const publishBtn = el.querySelector('.approveBtn') as HTMLButtonElement;
    await act(async () => publishBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(props.publish).toHaveBeenCalledWith('b1');
    expect(props.loadData).toHaveBeenCalledTimes(2);
  });

  it('toggles a live connection', async () => {
    const props = makeProps();
    const el = await mount(props);
    const pauseBtn = el.querySelector('.connection .denyBtn') as HTMLButtonElement;
    expect(pauseBtn.textContent).toBe('Pause');
    await act(async () => pauseBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(props.setConnectionStatus).toHaveBeenCalledWith('c1', 'paused');
  });

  it('shows the no-vault note when loadData resolves null', async () => {
    const el = await mount(makeProps({ loadData: vi.fn().mockResolvedValue(null) }));
    expect(el.textContent).toContain('nothing to import into');
  });
});
