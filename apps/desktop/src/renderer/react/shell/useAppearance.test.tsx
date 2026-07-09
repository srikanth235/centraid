import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const getUserPrefs = vi.fn();
const saveUserPrefs = vi.fn();
vi.mock('../../gateway-client.js', () => ({
  getUserPrefs: () => getUserPrefs(),
  saveUserPrefs: (p: unknown) => saveUserPrefs(p),
}));

let useAppearance: typeof import('./useAppearance.js').useAppearance;
let root: Root | null = null;
let host: HTMLElement | null = null;
const store = new Map<string, unknown>();

beforeEach(async () => {
  store.clear();
  (globalThis as unknown as { Store: unknown }).Store = {
    get: <T,>(k: string, d: T): T => (store.has(k) ? (store.get(k) as T) : d),
    set: (k: string, v: unknown) => store.set(k, v),
    remove: (k: string) => store.delete(k),
  };
  getUserPrefs.mockReset().mockResolvedValue({});
  saveUserPrefs.mockReset().mockResolvedValue(undefined);
  ({ useAppearance } = await import('./useAppearance.js'));
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

let ctl: ReturnType<typeof useAppearance>;
function Harness(): null {
  ctl = useAppearance();
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

describe('useAppearance', () => {
  it('seeds from defaults + the Store cache and writes <html>', async () => {
    store.set('appearance', { accent: 'rose' });
    await mount();
    expect(ctl.prefs.accent).toBe('rose');
    expect(document.documentElement.dataset.theme).toBe(ctl.prefs.theme);
  });

  it('reconciles recognised keys from the gateway after mount', async () => {
    getUserPrefs.mockResolvedValue({ theme: 'light', density: 'comfy' });
    await mount();
    await act(async () => {
      await Promise.resolve();
    });
    expect(ctl.prefs.theme).toBe('light');
    expect(ctl.prefs.density).toBe('comfy');
  });

  it('setPrefs updates state, caches to Store, and mirrors to the gateway', async () => {
    await mount();
    await act(async () => {
      ctl.setPrefs({ accent: 'violet' });
    });
    expect(ctl.prefs.accent).toBe('violet');
    expect(store.get('appearance')).toMatchObject({ accent: 'violet' });
    expect(saveUserPrefs).toHaveBeenCalledWith(expect.objectContaining({ accentKey: 'violet' }));
  });

  it('locks bgL to 5 regardless of the cached value', async () => {
    store.set('appearance', { bgL: 40 });
    await mount();
    expect(ctl.prefs.bgL).toBe(5);
  });
});
