import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { relaunchToUpdate, useUpdateStatus, type UpdateStatus } from './useUpdateStatus.js';

let root: Root | null = null;
let host: HTMLElement | null = null;

// Captured broadcast subscriber so tests can push an UPDATE_AVAILABLE.
let pushUpdate: ((msg: UpdateStatus) => void) | null = null;
const unsubscribe = vi.fn();
const relaunchIpc = vi.fn(() => Promise.resolve({ ok: true as const }));

function mockApi(status: UpdateStatus | null): void {
  (globalThis as unknown as { CentraidApi: unknown }).CentraidApi = {
    ...(status ? { getUpdateStatus: () => Promise.resolve(status) } : {}),
    onUpdateAvailable: (cb: (msg: UpdateStatus) => void) => {
      pushUpdate = cb;
      return unsubscribe;
    },
    relaunchToUpdate: relaunchIpc,
  };
}

beforeEach(() => {
  pushUpdate = null;
  unsubscribe.mockClear();
  relaunchIpc.mockClear();
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

let status: UpdateStatus | null = null;
function Harness(): null {
  status = useUpdateStatus();
  return null;
}
async function mount(): Promise<void> {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(<Harness />);
  });
  await act(async () => {
    await Promise.resolve();
  });
}

describe('useUpdateStatus', () => {
  it('stays null when the snapshot reports no update', async () => {
    mockApi({ available: false, version: '0.1.0' });
    await mount();
    expect(status).toBeNull();
  });

  it('adopts an already-available snapshot (window mounted after the broadcast)', async () => {
    mockApi({ available: true, version: '0.2.0' });
    await mount();
    expect(status).toEqual({ available: true, version: '0.2.0' });
  });

  it('flips when the UPDATE_AVAILABLE broadcast arrives, and unsubscribes on unmount', async () => {
    mockApi({ available: false, version: '0.1.0' });
    await mount();
    expect(status).toBeNull();
    act(() => pushUpdate?.({ available: true, version: '0.2.0' }));
    expect(status).toEqual({ available: true, version: '0.2.0' });
    act(() => root?.unmount());
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('survives a partial bridge with no update surface (test harnesses)', async () => {
    (globalThis as unknown as { CentraidApi: unknown }).CentraidApi = {};
    await mount();
    expect(status).toBeNull();
  });

  it('relaunchToUpdate forwards to the bridge', () => {
    mockApi(null);
    relaunchToUpdate();
    expect(relaunchIpc).toHaveBeenCalledTimes(1);
  });
});
