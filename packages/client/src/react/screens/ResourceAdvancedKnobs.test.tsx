import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ResourceAdvancedKnobs, { type ResourceAdvancedKnobsProps } from './ResourceAdvancedKnobs.js';
import {
  knobPrefKey,
  parseResourceKnobPrefs,
  type ResourceKnobPrefs,
  type ResourceProfileDTO,
} from './resource-summary.js';

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

// A profile carrying the Phase F `sources` + `bounds`. host.cores = 4 so a
// concurrency of 8 trips the soft "more workers than cores" warning; memory is
// generous so the product warning stays quiet unless a test forces it.
const tunedProfile: ResourceProfileDTO = {
  class: 'standard',
  mode: 'balanced',
  host: { cores: 4, totalMemoryBytes: 32 * 1024 ** 3, storageFsyncMs: 1.5 },
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
  sources: {
    workerMaxConcurrent: { source: 'preset' },
    workerMaxOldGenerationMb: { source: 'preset' },
    workerPoolSize: { source: 'env', envVar: 'CENTRAID_WORKER_POOL_SIZE' },
    replicationConcurrency: { source: 'prefs' },
    staticBrotliQuality: { source: 'preset' },
    staticGzipQuality: { source: 'preset' },
  },
  bounds: {
    workerMaxConcurrent: { min: 1, max: 32 },
    workerMaxOldGenerationMb: { min: 256, max: 8192 },
    workerPoolSize: { min: 1, max: 16 },
    replicationConcurrency: { min: 1, max: 16 },
    staticBrotliQuality: { min: 0, max: 11 },
    staticGzipQuality: { min: 1, max: 9 },
  },
};

const NO_OVERRIDES: ResourceKnobPrefs = {
  workerMaxConcurrent: null,
  workerMaxOldGenerationMb: null,
  workerPoolSize: null,
  replicationConcurrency: null,
};

async function mount(props: ResourceAdvancedKnobsProps): Promise<HTMLDivElement> {
  container = document.createElement('div');
  document.body.appendChild(container);
  await act(async () => {
    root = createRoot(container as HTMLDivElement);
    root.render(<ResourceAdvancedKnobs {...props} />);
  });
  await act(async () => {
    await Promise.resolve();
  });
  return container;
}

async function expand(el: HTMLElement): Promise<void> {
  const toggle = el.querySelector('[data-testid="resource-advanced-toggle"]') as HTMLButtonElement;
  await act(async () => toggle.dispatchEvent(new MouseEvent('click', { bubbles: true })));
}

function setInput(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function inputFor(el: HTMLElement, key: string): HTMLInputElement {
  return el.querySelector(`[data-testid="knob-${key}"] input`) as HTMLInputElement;
}

function saveBtn(el: HTMLElement, key: string): HTMLButtonElement {
  const row = el.querySelector(`[data-testid="knob-${key}"]`) as HTMLElement;
  return [...row.querySelectorAll('button')].find(
    (b) => b.textContent?.trim() === 'Save',
  ) as HTMLButtonElement;
}

describe('resource knob prefs helpers', () => {
  it('maps knob keys to the gateway.resource.* pref namespace', () => {
    expect(knobPrefKey('workerMaxConcurrent')).toBe('gateway.resource.workerMaxConcurrent');
    expect(knobPrefKey('replicationConcurrency')).toBe('gateway.resource.replicationConcurrency');
  });

  it('reads positive integers and rejects everything else', () => {
    const prefs = parseResourceKnobPrefs({
      'gateway.resource.workerMaxConcurrent': 4,
      'gateway.resource.workerMaxOldGenerationMb': 0,
      'gateway.resource.workerPoolSize': 2.5,
      'gateway.resource.replicationConcurrency': 'nope',
    });
    expect(prefs).toEqual({
      workerMaxConcurrent: 4,
      workerMaxOldGenerationMb: null,
      workerPoolSize: null,
      replicationConcurrency: null,
    });
  });
});

describe('ResourceAdvancedKnobs', () => {
  it('is collapsed by default and reveals four rows on expand', async () => {
    const el = await mount({
      profile: tunedProfile,
      loadKnobPrefs: vi.fn().mockResolvedValue(NO_OVERRIDES),
      saveKnobPrefs: vi.fn(),
    });
    const toggle = el.querySelector(
      '[data-testid="resource-advanced-toggle"]',
    ) as HTMLButtonElement;
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(el.querySelector('[data-testid="resource-advanced-body"]')).toBeNull();

    await expand(el);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(el.querySelector('[data-testid="knob-workerMaxConcurrent"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="knob-workerMaxOldGenerationMb"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="knob-workerPoolSize"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="knob-replicationConcurrency"]')).not.toBeNull();
  });

  it('renders Linked, Custom, and env-locked states', async () => {
    const el = await mount({
      profile: tunedProfile,
      loadKnobPrefs: vi.fn().mockResolvedValue({ ...NO_OVERRIDES, replicationConcurrency: 4 }),
      saveKnobPrefs: vi.fn(),
    });
    await expand(el);

    // preset + no override → Linked, editable.
    const linkedRow = el.querySelector('[data-testid="knob-workerMaxConcurrent"]') as HTMLElement;
    expect(linkedRow.textContent).toContain('Linked');
    expect(inputFor(el, 'workerMaxConcurrent').disabled).toBe(false);

    // saved override → Custom, with a Reset-to-Linked affordance.
    const customRow = el.querySelector(
      '[data-testid="knob-replicationConcurrency"]',
    ) as HTMLElement;
    expect(customRow.textContent).toContain('Custom');
    expect(inputFor(el, 'replicationConcurrency').value).toBe('4');
    expect(
      [...customRow.querySelectorAll('button')].some(
        (b) => b.textContent?.trim() === 'Reset to Linked',
      ),
    ).toBe(true);

    // env → locked: input disabled, env var named, no Save button.
    const lockedRow = el.querySelector('[data-testid="knob-workerPoolSize"]') as HTMLElement;
    expect(inputFor(el, 'workerPoolSize').disabled).toBe(true);
    expect(el.querySelector('[data-testid="knob-workerPoolSize-lock"]')?.textContent).toContain(
      'CENTRAID_WORKER_POOL_SIZE',
    );
    expect(lockedRow.textContent).toContain('remove the variable to tune here');
    expect(
      [...lockedRow.querySelectorAll('button')].some((b) => b.textContent?.trim() === 'Save'),
    ).toBe(false);
  });

  it('hard-rejects an out-of-bounds value: inline error, Save disabled', async () => {
    const saveKnobPrefs = vi.fn().mockResolvedValue(undefined);
    const el = await mount({
      profile: tunedProfile,
      loadKnobPrefs: vi.fn().mockResolvedValue(NO_OVERRIDES),
      saveKnobPrefs,
    });
    await expand(el);
    await act(async () => setInput(inputFor(el, 'workerMaxConcurrent'), '999'));

    expect(
      el.querySelector('[data-testid="knob-workerMaxConcurrent-error"]')?.textContent,
    ).toContain('Out of range (1–32).');
    expect(saveBtn(el, 'workerMaxConcurrent').disabled).toBe(true);
  });

  it('shows a soft warning but still allows saving', async () => {
    const saveKnobPrefs = vi.fn().mockResolvedValue(undefined);
    const el = await mount({
      profile: tunedProfile,
      loadKnobPrefs: vi.fn().mockResolvedValue(NO_OVERRIDES),
      saveKnobPrefs,
    });
    await expand(el);
    // 8 workers on a 4-core host: within bounds (max 32) but over cores.
    await act(async () => setInput(inputFor(el, 'workerMaxConcurrent'), '8'));

    expect(
      el.querySelector('[data-testid="knob-workerMaxConcurrent-warn"]')?.textContent,
    ).toContain('More workers than');
    expect(el.querySelector('[data-testid="knob-workerMaxConcurrent-error"]')).toBeNull();
    expect(saveBtn(el, 'workerMaxConcurrent').disabled).toBe(false);
  });

  it('saves a valid override through the bridge', async () => {
    const saveKnobPrefs = vi.fn().mockResolvedValue(undefined);
    const el = await mount({
      profile: tunedProfile,
      loadKnobPrefs: vi.fn().mockResolvedValue(NO_OVERRIDES),
      saveKnobPrefs,
    });
    await expand(el);
    await act(async () => setInput(inputFor(el, 'workerMaxConcurrent'), '3'));
    await act(async () =>
      saveBtn(el, 'workerMaxConcurrent').dispatchEvent(new MouseEvent('click', { bubbles: true })),
    );

    expect(saveKnobPrefs).toHaveBeenCalledWith({ workerMaxConcurrent: 3 });
    expect(el.querySelector('[data-testid="resource-advanced-saved"]')?.textContent).toContain(
      'Applies on the next gateway restart',
    );
    // The row now reads Custom.
    expect(el.querySelector('[data-testid="knob-workerMaxConcurrent"]')?.textContent).toContain(
      'Custom',
    );
  });

  it('clears a Custom override back to Linked by writing null', async () => {
    const saveKnobPrefs = vi.fn().mockResolvedValue(undefined);
    const el = await mount({
      profile: tunedProfile,
      loadKnobPrefs: vi.fn().mockResolvedValue({ ...NO_OVERRIDES, replicationConcurrency: 4 }),
      saveKnobPrefs,
    });
    await expand(el);
    const row = el.querySelector('[data-testid="knob-replicationConcurrency"]') as HTMLElement;
    const reset = [...row.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === 'Reset to Linked',
    ) as HTMLButtonElement;
    await act(async () => reset.dispatchEvent(new MouseEvent('click', { bubbles: true })));

    expect(saveKnobPrefs).toHaveBeenCalledWith({ replicationConcurrency: null });
    expect(el.querySelector('[data-testid="knob-replicationConcurrency"]')?.textContent).toContain(
      'Linked',
    );
  });

  it('renders nothing when the profile lacks sources/bounds (older gateway)', async () => {
    const legacy: ResourceProfileDTO = {
      class: tunedProfile.class,
      mode: tunedProfile.mode,
      host: tunedProfile.host,
      resolved: tunedProfile.resolved,
    };
    const el = await mount({
      profile: legacy,
      loadKnobPrefs: vi.fn().mockResolvedValue(NO_OVERRIDES),
      saveKnobPrefs: vi.fn(),
    });
    expect(el.querySelector('[data-testid="resource-advanced-toggle"]')).toBeNull();
    expect(el.textContent).toBe('');
  });
});
