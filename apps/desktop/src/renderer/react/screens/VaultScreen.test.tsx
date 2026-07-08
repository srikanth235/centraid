import { act } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { VaultBridgeProps, VaultData } from '../bridge.js';
import VaultScreen from './VaultScreen.js';

const block: VaultBridgeProps['block'] = {
  purpose: 'Read your notes',
  why: 'To summarize them.',
  scopes: [{ schema: 'notes', table: 'note', verbs: 'read' }],
};

const baseData: VaultData = {
  vaultName: 'home',
  grants: [],
  parked: [],
};

function makeProps(over: Partial<VaultBridgeProps> = {}): VaultBridgeProps {
  return {
    block,
    confirm: vi.fn().mockResolvedValue(undefined),
    demoLoad: vi.fn().mockResolvedValue(undefined),
    demoPurge: vi.fn().mockResolvedValue(undefined),
    grant: vi.fn().mockResolvedValue(undefined),
    loadData: vi.fn().mockResolvedValue(baseData),
    revoke: vi.fn().mockResolvedValue(undefined),
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
});

async function mount(props: VaultBridgeProps): Promise<HTMLDivElement> {
  container = document.createElement('div');
  document.body.appendChild(container);
  await act(async () => {
    root = createRoot(container as HTMLDivElement);
    root.render(<VaultScreen {...props} />);
  });
  return container;
}

describe('VaultScreen', () => {
  it('always shows the requested-access section (even before data loads)', () => {
    const html = renderToStaticMarkup(<VaultScreen {...makeProps()} />);
    expect(html).toContain('Requested access');
    expect(html).toContain('notes.note');
    expect(html).toContain('To summarize them.');
    expect(html).toContain('Purpose · Read your notes');
  });

  it('renders the grant CTA when the app holds no grants', async () => {
    const el = await mount(makeProps());
    expect(el.textContent).toContain('No access yet');
    expect(el.querySelector('.cd-vault-grant-btn')?.textContent).toBe('Grant access');
  });

  it('reports the parked count and renders parked cards', async () => {
    const onParkedCount = vi.fn();
    const data: VaultData = {
      ...baseData,
      parked: [
        {
          invocationId: 'iv1',
          command: 'notes.write',
          parkedAt: new Date().toISOString(),
          callerKind: 'app',
          caller: 'notes',
          input: { title: 'hi' },
        },
      ],
    };
    const el = await mount(makeProps({ loadData: vi.fn().mockResolvedValue(data), onParkedCount }));
    expect(onParkedCount).toHaveBeenCalledWith(1);
    expect(el.textContent).toContain('Waiting for your say-so');
    expect(el.querySelector('.cd-vault-approve-btn')).toBeTruthy();
  });

  it('runs the grant action then reloads', async () => {
    const props = makeProps();
    const el = await mount(props);
    const btn = el.querySelector('.cd-vault-grant-btn') as HTMLButtonElement;
    await act(async () => {
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(props.grant).toHaveBeenCalledTimes(1);
    // one initial load + one after the action
    expect(props.loadData).toHaveBeenCalledTimes(2);
  });

  it('shows the no-vault note when loadData resolves null', async () => {
    const el = await mount(makeProps({ loadData: vi.fn().mockResolvedValue(null) }));
    expect(el.textContent).toContain('No vault is mounted');
  });
});
