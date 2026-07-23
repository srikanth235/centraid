import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ResourceModeCard, {
  parseResourceModePref,
  RESOURCE_MODE_PREF_KEY,
  type ResourceMode,
} from './ResourceModeCard.js';

let root: Root | null = null;
let container: HTMLDivElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  vi.clearAllMocks();
});

async function mount(props: {
  loadMode: () => Promise<ResourceMode>;
  saveMode: (mode: ResourceMode) => Promise<void>;
  resolvedClass?: string;
  activeMode?: string;
}): Promise<HTMLDivElement> {
  container = document.createElement('div');
  document.body.appendChild(container);
  await act(async () => {
    root = createRoot(container as HTMLDivElement);
    root.render(<ResourceModeCard {...props} />);
  });
  await act(async () => {
    await Promise.resolve();
  });
  return container;
}

describe('parseResourceModePref', () => {
  it('reads the durable prefs key and defaults to auto', () => {
    expect(parseResourceModePref({ [RESOURCE_MODE_PREF_KEY]: 'conserve' })).toBe('conserve');
    expect(parseResourceModePref({})).toBe('auto');
    expect(parseResourceModePref({ [RESOURCE_MODE_PREF_KEY]: 'nope' })).toBe('auto');
  });
});

describe('ResourceModeCard', () => {
  it('renders the four modes and highlights the loaded selection', async () => {
    const el = await mount({
      loadMode: vi.fn().mockResolvedValue('conserve'),
      saveMode: vi.fn(),
    });
    expect(el.textContent).toContain('Resource mode');
    expect(el.textContent).toContain('Auto');
    expect(el.textContent).toContain('Conserve');
    expect(el.textContent).toContain('Balanced');
    expect(el.textContent).toContain('Performance');
    const selected = el.querySelector('[role="radio"][aria-checked="true"]');
    expect(selected?.textContent).toContain('Conserve');
  });

  it('saves a new mode through the bridge', async () => {
    const saveMode = vi.fn().mockResolvedValue(undefined);
    const el = await mount({
      loadMode: vi.fn().mockResolvedValue('auto'),
      saveMode,
    });
    const performance = [...el.querySelectorAll('[role="radio"]')].find((b) =>
      b.textContent?.includes('Performance'),
    ) as HTMLButtonElement;
    await act(async () => performance.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(saveMode).toHaveBeenCalledWith('performance');
    expect(el.textContent).toContain('Applies fully on the next gateway restart');
  });

  it('does not re-fetch when the parent re-renders with a stable loadMode', async () => {
    // Mirrors GatewayRoute: 1s now-tick re-renders with the same useCallback
    // loadMode. A deps=[props] refresh would re-call getUserPrefs every second.
    const loadMode = vi.fn().mockResolvedValue('auto' as ResourceMode);
    const saveMode = vi.fn().mockResolvedValue(undefined);
    const el = await mount({ loadMode, saveMode });
    expect(loadMode).toHaveBeenCalledTimes(1);

    await act(async () => {
      root?.render(<ResourceModeCard loadMode={loadMode} saveMode={saveMode} />);
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(loadMode).toHaveBeenCalledTimes(1);
    expect(el.querySelector('[role="radio"][aria-checked="true"]')?.textContent).toContain('Auto');
  });

  it('ignores a late loadMode resolve while a save is in flight', async () => {
    let resolveLoad!: (mode: ResourceMode) => void;
    const loadMode = vi.fn(
      () =>
        new Promise<ResourceMode>((resolve) => {
          resolveLoad = resolve;
        }),
    );
    let resolveSave!: () => void;
    const saveMode = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveSave = resolve;
        }),
    );

    const el = await mount({ loadMode, saveMode });
    // Initial load still pending — selection starts before it settles.
    const performance = [...el.querySelectorAll('[role="radio"]')].find((b) =>
      b.textContent?.includes('Performance'),
    ) as HTMLButtonElement;
    await act(async () => performance.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(saveMode).toHaveBeenCalledWith('performance');
    expect(el.querySelector('[role="radio"][aria-checked="true"]')?.textContent).toContain(
      'Performance',
    );

    // Stale GET returns Auto; must not snap the radio back mid-save.
    await act(async () => {
      resolveLoad('auto');
      await Promise.resolve();
    });
    expect(el.querySelector('[role="radio"][aria-checked="true"]')?.textContent).toContain(
      'Performance',
    );

    await act(async () => {
      resolveSave();
      await Promise.resolve();
    });
    expect(el.textContent).toContain('Applies fully on the next gateway restart');
    expect(el.querySelector('[role="radio"][aria-checked="true"]')?.textContent).toContain(
      'Performance',
    );
  });
});
