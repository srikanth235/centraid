import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ResourceModeCard, {
  parseResourceModePref,
  RESOURCE_MODE_PREF_KEY,
  type ResourceMode,
  type ResourceModeCardProps,
} from './ResourceModeCard.js';
import { msUntilTonight, type ResourceProfileDTO } from './resource-summary.js';

let root: Root | null = null;
let container: HTMLDivElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

const sampleProfile: ResourceProfileDTO = {
  class: 'standard',
  mode: 'balanced',
  host: { cores: 8, totalMemoryBytes: 16 * 1024 ** 3, storageFsyncMs: 1.5 },
  resolved: {
    workerMaxConcurrent: 2,
    workerMaxOldGenerationMb: 1280,
    workerPoolSize: 3,
    replicationConcurrency: 2,
    staticBrotliQuality: 6,
    staticGzipQuality: 7,
    sqliteSynchronous: 'FULL',
    vaultSweepIntervalMs: 300_000,
    outboxIdleIntervalMs: 1000,
  },
};

async function mount(props: ResourceModeCardProps): Promise<HTMLDivElement> {
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

function clickByText(el: HTMLElement, text: string): void {
  const btn = [...el.querySelectorAll('button')].find((b) => b.textContent?.trim() === text);
  if (!btn) throw new Error(`no button with text "${text}"`);
  btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
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

describe('ResourceModeCard — L1 budget summary + L2 disclosure', () => {
  it('renders the budget line + host attribution from resourceProfile', async () => {
    const el = await mount({
      loadMode: vi.fn().mockResolvedValue('balanced'),
      saveMode: vi.fn(),
      resourceProfile: sampleProfile,
    });
    const summary = el.querySelector('[data-testid="resource-summary"]');
    expect(summary?.textContent).toContain(
      'Up to ~2.5 GB memory · 2 background workers on 8 cores',
    );
    expect(summary?.textContent).toContain('Sized for this gateway’s host');
  });

  it('opens the "How we sized this" dialog with host facts + resolved knobs', async () => {
    const el = await mount({
      loadMode: vi.fn().mockResolvedValue('balanced'),
      saveMode: vi.fn(),
      resourceProfile: sampleProfile,
    });
    // Closed by default — no dialog, no body in the tree.
    expect(el.querySelector('[data-testid="resource-details-dialog"]')).toBeNull();
    expect(el.querySelector('[data-testid="resource-details-body"]')).toBeNull();

    const open = el.querySelector('[data-testid="resource-details-open"]') as HTMLButtonElement;
    await act(async () => open.dispatchEvent(new MouseEvent('click', { bubbles: true })));

    const dialog = el.querySelector('[data-testid="resource-details-dialog"]');
    expect(dialog).not.toBeNull();
    const body = el.querySelector('[data-testid="resource-details-body"]');
    expect(body?.textContent).toContain('CPU cores');
    expect(body?.textContent).toContain('2 × 1280 MB');
    expect(body?.textContent).toContain('every 5 min');

    // The close button dismisses it.
    const close = dialog?.querySelector('[aria-label="Close"]') as HTMLButtonElement;
    await act(async () => close.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(el.querySelector('[data-testid="resource-details-dialog"]')).toBeNull();
  });

  it('omits L1 + the sizing opener when resourceProfile is absent (older gateway)', async () => {
    const el = await mount({
      loadMode: vi.fn().mockResolvedValue('auto'),
      saveMode: vi.fn(),
    });
    expect(el.querySelector('[data-testid="resource-summary"]')).toBeNull();
    expect(el.querySelector('[data-testid="resource-details-open"]')).toBeNull();
    // Compare works off static presets, so its opener is always present.
    expect(el.querySelector('[data-testid="resource-compare-open"]')).not.toBeNull();
    // The card still renders its mode chips.
    expect(el.querySelectorAll('[role="radio"]')).toHaveLength(4);
  });
});

describe('ResourceModeCard — compare modes dialog', () => {
  it('opens the compare dialog, shows preset values, and applies a chosen mode', async () => {
    const saveMode = vi.fn().mockResolvedValue(undefined);
    const el = await mount({
      loadMode: vi.fn().mockResolvedValue('balanced'),
      saveMode,
      resourceProfile: sampleProfile,
    });
    const open = el.querySelector('[data-testid="resource-compare-open"]') as HTMLButtonElement;
    await act(async () => open.dispatchEvent(new MouseEvent('click', { bubbles: true })));

    const dialog = el.querySelector('[data-testid="resource-compare-dialog"]');
    expect(dialog).not.toBeNull();
    // Static preset values from the mirror are visible side by side.
    expect(dialog?.textContent).toContain('brotli q10');
    expect(dialog?.textContent).toContain('Relaxed');

    const perf = el.querySelector(
      '[data-testid="resource-compare-mode-performance"]',
    ) as HTMLButtonElement;
    await act(async () => perf.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    const apply = el.querySelector('[data-testid="resource-compare-apply"]') as HTMLButtonElement;
    await act(async () => apply.dispatchEvent(new MouseEvent('click', { bubbles: true })));

    expect(saveMode).toHaveBeenCalledWith('performance');
    // Applying closes the dialog.
    expect(el.querySelector('[data-testid="resource-compare-dialog"]')).toBeNull();
    expect(el.textContent).toContain('Applies fully on the next gateway restart');
  });
});

describe('ResourceModeCard — pause background work (L0)', () => {
  it('hides the pause control when backgroundPause is absent', async () => {
    const el = await mount({
      loadMode: vi.fn().mockResolvedValue('auto'),
      saveMode: vi.fn(),
      onPause: vi.fn(),
      onResume: vi.fn(),
    });
    expect(el.querySelector('[data-testid="resource-pause"]')).toBeNull();
  });

  it('reveals durations and pauses with the chosen ms', async () => {
    const onPause = vi
      .fn()
      .mockResolvedValue({ paused: true, until: new Date(2026, 6, 23, 15, 0, 0).toISOString() });
    const el = await mount({
      loadMode: vi.fn().mockResolvedValue('auto'),
      saveMode: vi.fn(),
      backgroundPause: { paused: false, until: null },
      onPause,
      onResume: vi.fn(),
    });

    const open = el.querySelector('[data-testid="resource-pause-open"]') as HTMLButtonElement;
    await act(async () => open.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(el.querySelector('[aria-label="Pause duration"]')).not.toBeNull();

    await act(async () => clickByText(el, '1 hour'));
    expect(onPause).toHaveBeenCalledWith(3_600_000);
    expect(el.querySelector('[data-testid="resource-pause-active"]')?.textContent).toContain(
      'Paused until 15:00',
    );
  });

  it('passes the computed ms for "Until tonight"', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(new Date(2026, 6, 23, 10, 0, 0).getTime());
    const onPause = vi.fn().mockResolvedValue({ paused: true, until: null });
    const el = await mount({
      loadMode: vi.fn().mockResolvedValue('auto'),
      saveMode: vi.fn(),
      backgroundPause: { paused: false, until: null },
      onPause,
      onResume: vi.fn(),
    });
    const open = el.querySelector('[data-testid="resource-pause-open"]') as HTMLButtonElement;
    await act(async () => open.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await act(async () => clickByText(el, 'Until tonight'));
    expect(onPause).toHaveBeenCalledWith(msUntilTonight(new Date(2026, 6, 23, 10, 0, 0).getTime()));
  });

  it('shows the paused state and resumes', async () => {
    const onResume = vi.fn().mockResolvedValue({ paused: false });
    const el = await mount({
      loadMode: vi.fn().mockResolvedValue('auto'),
      saveMode: vi.fn(),
      backgroundPause: { paused: true, until: new Date(2026, 6, 23, 14, 5, 0).toISOString() },
      onPause: vi.fn(),
      onResume,
    });
    expect(el.querySelector('[data-testid="resource-pause-active"]')?.textContent).toContain(
      'Paused until 14:05',
    );
    await act(async () => clickByText(el, 'Resume'));
    expect(onResume).toHaveBeenCalledTimes(1);
    // Optimistic flip back to the idle "Pause background work" affordance.
    expect(el.querySelector('[data-testid="resource-pause-open"]')).not.toBeNull();
  });

  it('reconciles the paused state from a later health poll', async () => {
    const props: ResourceModeCardProps = {
      loadMode: vi.fn().mockResolvedValue('auto'),
      saveMode: vi.fn(),
      backgroundPause: { paused: false, until: null },
      onPause: vi.fn(),
      onResume: vi.fn(),
    };
    const el = await mount(props);
    expect(el.querySelector('[data-testid="resource-pause-open"]')).not.toBeNull();

    // The 15s poll lands a paused snapshot from another surface.
    await act(async () => {
      root?.render(
        <ResourceModeCard
          {...props}
          backgroundPause={{ paused: true, until: new Date(2026, 6, 23, 9, 30, 0).toISOString() }}
        />,
      );
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(el.querySelector('[data-testid="resource-pause-active"]')?.textContent).toContain(
      'Paused until 09:30',
    );
  });
});
