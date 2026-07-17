import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import RecoverScreen, { type RecoverScreenProps } from './RecoverScreen.js';
import type { RecoverEvent } from '../../gateway-client-recover.js';

// gateway-client-core registers window.CentraidApi listeners at module load
// (imported transitively via gateway-client-recover); stub it before that graph
// evaluates. `vi.hoisted` is lifted above the imports above regardless of where
// it sits textually — so it runs first while imports stay lint-clean.
vi.hoisted(() => {
  (window as unknown as { CentraidApi: Record<string, unknown> }).CentraidApi = {
    onGatewayChanged: () => () => undefined,
    onVaultChanged: () => () => undefined,
    getGatewayAuth: async () => ({ baseUrl: 'https://gateway.test', token: 't' }),
  };
});

function makeProps(over: Partial<RecoverScreenProps> = {}): RecoverScreenProps {
  return {
    validateKit: vi.fn().mockResolvedValue({
      ok: true,
      createdAt: '2026-07-17T00:00:00.000Z',
      targets: [{ label: 'home', vaultId: 'v1', providerHost: 'storage.example.com' }],
    }),
    discover: vi.fn().mockResolvedValue({
      found: true,
      label: 'home',
      vaultId: 'v1',
      providerHost: 'storage.example.com',
      sizeBytes: 4_500_000_000,
      asOfMs: 1_700_000_000_000,
      restoreCostClass: 'free-egress',
      lazyAvailable: true,
    }),
    start: vi.fn().mockResolvedValue({ started: true, jobId: 'job-1' }),
    status: vi.fn().mockResolvedValue({ fresh: true, job: null }),
    streamEvents: vi.fn().mockReturnValue(new Promise<void>(() => undefined)),
    onRecovered: vi.fn(),
    onBack: vi.fn(),
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
  vi.restoreAllMocks();
});

async function flush(times = 4): Promise<void> {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

async function mount(props: RecoverScreenProps): Promise<HTMLDivElement> {
  container = document.createElement('div');
  document.body.appendChild(container);
  await act(async () => {
    root = createRoot(container as HTMLDivElement);
    root.render(<RecoverScreen {...props} />);
  });
  await flush();
  return container;
}

function setNativeValue(el: HTMLTextAreaElement | HTMLInputElement, value: string): void {
  const proto =
    el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  act(() => {
    setter?.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function clickText(el: HTMLElement, text: string): void {
  const btn = [...el.querySelectorAll('button')].find((b) => b.textContent === text);
  act(() => btn?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
}

async function toKey(el: HTMLElement): Promise<void> {
  setNativeValue(el.querySelector('.textarea') as HTMLTextAreaElement, '{"kind":"x"}');
  clickText(el, 'Continue');
  await flush();
}

async function toFound(el: HTMLElement): Promise<void> {
  await toKey(el);
  setNativeValue(el.querySelector('#cd-rec-key') as HTMLInputElement, 'k');
  clickText(el, 'Find my vault');
  await flush();
}

describe('RecoverScreen', () => {
  it('surfaces the gateway invalid-kit message and stays on the kit step', async () => {
    const props = makeProps({
      validateKit: vi.fn().mockResolvedValue({ ok: false, message: 'not a centraid recovery kit' }),
    });
    const el = await mount(props);
    setNativeValue(el.querySelector('.textarea') as HTMLTextAreaElement, '{"x":1}');
    clickText(el, 'Continue');
    await flush();
    expect(el.textContent).toContain('not a centraid recovery kit');
    expect(el.querySelector('.textarea')).toBeTruthy(); // still on the kit step
  });

  it('a bad paste never reaches the gateway', async () => {
    const props = makeProps();
    const el = await mount(props);
    setNativeValue(el.querySelector('.textarea') as HTMLTextAreaElement, 'not json');
    clickText(el, 'Continue');
    await flush();
    expect(props.validateKit).not.toHaveBeenCalled();
    expect(el.textContent).toContain("doesn't look like a recovery kit");
  });

  it('advances to the key step showing the provider host', async () => {
    const el = await mount(makeProps());
    await toKey(el);
    expect(el.textContent).toContain('Access key');
    expect(el.textContent).toContain('storage.example.com');
  });

  it('shows a wrong-key error inline', async () => {
    const props = makeProps({
      discover: vi.fn().mockResolvedValue({ found: false, reason: 'wrong_key', message: 'nope' }),
    });
    const el = await mount(props);
    await toFound(el);
    expect(el.textContent).toContain("That key didn't work");
  });

  it('a free-egress vault recovers with no price confirm', async () => {
    const props = makeProps();
    const el = await mount(props);
    await toFound(el);
    expect(el.textContent).toContain('Found your vault');
    expect(el.textContent).toContain('4.2 GB');
    expect(el.textContent).toContain('hosted at storage.example.com');
    clickText(el, 'Recover this vault');
    await flush();
    expect(props.start).toHaveBeenCalledWith({ kit: { kind: 'x' }, apiKey: 'k' });
    expect(el.textContent).toContain('Bringing your vault back');
  });

  it('a metered vault shows the download confirm before starting', async () => {
    const props = makeProps({
      discover: vi.fn().mockResolvedValue({
        found: true,
        label: 'home',
        vaultId: 'v1',
        providerHost: 'storage.example.com',
        sizeBytes: 9_000_000_000,
        asOfMs: 1_700_000_000_000,
        restoreCostClass: 'metered-egress',
        lazyAvailable: true,
      }),
    });
    const el = await mount(props);
    await toFound(el);
    clickText(el, 'Recover this vault');
    await flush();
    expect(props.start).not.toHaveBeenCalled();
    expect(el.textContent).toContain('will pull about');
    expect(el.textContent).toContain('8.4 GB');
    clickText(el, 'Yes, recover');
    await flush();
    expect(props.start).toHaveBeenCalledWith({ kit: { kind: 'x' }, apiKey: 'k', confirmed: true });
  });

  it('streams progress phases and lands with the quarantine hand-off', async () => {
    let emit: (ev: RecoverEvent) => void = () => undefined;
    const streamEvents = vi.fn().mockImplementation((_job, onEvent) => {
      emit = onEvent;
      return new Promise<void>(() => undefined);
    });
    const props = makeProps({ streamEvents });
    const el = await mount(props);
    await toFound(el);
    clickText(el, 'Recover this vault');
    await flush();
    expect(streamEvents).toHaveBeenCalledWith('job-1', expect.any(Function), expect.any(Object));

    await act(async () => emit({ kind: 'phase', phase: 'replaying' }));
    const active = el.querySelector('.stage[data-state="active"] .stageLabel');
    expect(active?.textContent).toBe('Replaying recent changes');

    await act(async () =>
      emit({
        kind: 'report',
        report: {
          vaultId: 'v1',
          recoveredAsOf: 1_700_000_000_000,
          quarantine: ['outbox', 'connections'],
        },
      }),
    );
    await act(async () => emit({ kind: 'end', state: 'done' }));
    await flush();

    expect(el.textContent).toContain("You're back");
    expect(el.textContent).toContain('Recovered as of');
    expect(el.textContent).toContain('waiting for your OK');

    clickText(el, 'Enter Centraid');
    expect(props.onRecovered).toHaveBeenCalledTimes(1);
  });

  it('a non-fresh gateway is refused in plain language', async () => {
    const props = makeProps({
      start: vi.fn().mockResolvedValue({ started: false, reason: 'not_fresh', message: 'x' }),
    });
    const el = await mount(props);
    await toFound(el);
    clickText(el, 'Recover this vault');
    await flush();
    expect(el.textContent).toContain('This computer already has a vault');
  });

  it('reattaches to a running job on mount', async () => {
    const props = makeProps({
      status: vi.fn().mockResolvedValue({
        fresh: false,
        job: { jobId: 'j', state: 'running', phase: 'warming' },
      }),
    });
    const el = await mount(props);
    expect(el.textContent).toContain('Bringing your vault back');
    const active = el.querySelector('.stage[data-state="active"] .stageLabel');
    expect(active?.textContent).toBe('Warming previews');
  });

  it('reattaches to a finished job as the landing state', async () => {
    const props = makeProps({
      status: vi.fn().mockResolvedValue({
        fresh: false,
        job: {
          jobId: 'j',
          state: 'done',
          phase: 'done',
          report: { vaultId: 'v1', recoveredAsOf: 1_700_000_000_000, quarantine: [] },
        },
      }),
    });
    const el = await mount(props);
    expect(el.textContent).toContain("You're back");
  });
});
