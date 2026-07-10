import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const getBlocking = vi.fn();
vi.mock('../../gateway-client.js', () => ({ getBlocking: () => getBlocking() }));

let useBlockingCount: typeof import('./useBlockingCount.js').useBlockingCount;
let root: Root | null = null;
let host: HTMLElement | null = null;

beforeEach(async () => {
  getBlocking.mockReset();
  ({ useBlockingCount } = await import('./useBlockingCount.js'));
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

let count = 0;
function Harness(): null {
  count = useBlockingCount();
  return null;
}
async function mount(): Promise<void> {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(<Harness />);
  });
}

describe('useBlockingCount', () => {
  it('sums all four blocking groups', async () => {
    getBlocking.mockResolvedValue({
      outbox: [{}, {}],
      needsAuth: [{}],
      parked: [{}, {}, {}],
      scopeRequests: [],
    });
    await mount();
    expect(count).toBe(6);
  });

  it('stays at the last known count when the gateway is unreachable', async () => {
    getBlocking.mockRejectedValue(new Error('offline'));
    await mount();
    expect(count).toBe(0);
  });

  it('refreshes on window focus', async () => {
    getBlocking.mockResolvedValue({ outbox: [], needsAuth: [], parked: [], scopeRequests: [] });
    await mount();
    expect(count).toBe(0);
    getBlocking.mockResolvedValue({ outbox: [{}], needsAuth: [], parked: [], scopeRequests: [] });
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    expect(count).toBe(1);
  });
});
