import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import TestConnectionModal from './TestConnectionModal.js';

// connectFlowIO.js (pulled in transitively for local-vault loading elsewhere
// in the module) imports gateway-client.js, which registers an
// `onGatewayChanged` listener at module-load time — stub it so that load-time
// side effect doesn't reach for a `window.CentraidApi` this file only wires
// up inside `beforeEach` (same trap spaceModals.test.ts / ConnectFlow.test.tsx
// sidestep).
vi.mock('../../../gateway-client.js', () => ({ listVaults: () => Promise.resolve([]) }));

const testGatewayConnection = vi.fn();

beforeEach(() => {
  testGatewayConnection.mockReset();
  (globalThis as unknown as { CentraidApi: unknown }).CentraidApi = { testGatewayConnection };
});

let root: Root | null = null;
let container: HTMLDivElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
});

function mount(onClose: () => void): HTMLDivElement {
  container = document.createElement('div');
  document.body.appendChild(container);
  act(() => {
    root = createRoot(container as HTMLDivElement);
    root.render(
      <TestConnectionModal gatewayId="home" gatewayLabel="home-server" onClose={onClose} />,
    );
  });
  return container;
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('TestConnectionModal', () => {
  it('runs the test against {kind:"gateway", gatewayId} on mount and renders the report', async () => {
    testGatewayConnection.mockResolvedValue({
      ok: true,
      stages: [{ id: 'reach', label: 'Reach', status: 'pass' }],
      gateway: { version: '0.5.2', schemaEpoch: 3, instanceId: 'i1', compatible: true },
    });
    const el = mount(vi.fn());
    await flush();
    expect(testGatewayConnection).toHaveBeenCalledWith({ gatewayId: 'home', kind: 'gateway' });
    expect(el.textContent).toContain('Reach');
    expect(el.textContent).toContain('v0.5.2');
  });

  it('Retry re-runs the test', async () => {
    testGatewayConnection.mockResolvedValue({ ok: true, stages: [] });
    const el = mount(vi.fn());
    await flush();
    const retry = [...el.querySelectorAll('button')].find(
      (b) => b.textContent === 'Retry',
    ) as HTMLButtonElement;
    act(() => retry.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await flush();
    expect(testGatewayConnection).toHaveBeenCalledTimes(2);
  });

  it('Close fires onClose', async () => {
    testGatewayConnection.mockResolvedValue({ ok: true, stages: [] });
    const onClose = vi.fn();
    const el = mount(onClose);
    await flush();
    const close = [...el.querySelectorAll('button')].find(
      (b) => b.textContent === 'Close',
    ) as HTMLButtonElement;
    act(() => close.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
