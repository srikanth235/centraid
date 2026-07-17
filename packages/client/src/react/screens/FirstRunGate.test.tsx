import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import FirstRunGate, { type FirstRunGateProps } from './FirstRunGate.js';

// FirstRunGate pulls in OnboardingScreen (→ ConnectFlow → gateway-client) and
// RecoverScreen (→ gateway-client-recover), both of which reach
// gateway-client-core's module-load window.CentraidApi listeners. `vi.hoisted`
// is lifted above the import above, so this stub is in place before that graph
// evaluates while the import stays lint-clean.
vi.hoisted(() => {
  (window as unknown as { CentraidApi: Record<string, unknown> }).CentraidApi = {
    onGatewayChanged: () => () => undefined,
    onVaultChanged: () => () => undefined,
    getGatewayAuth: async () => ({ baseUrl: 'https://gateway.test', token: 't' }),
  };
});

function makeProps(over: Partial<FirstRunGateProps> = {}): FirstRunGateProps {
  return {
    onOnboardingComplete: vi.fn(),
    onRecoveryComplete: vi.fn(),
    recover: {
      validateKit: vi.fn().mockResolvedValue({ ok: true, createdAt: '', targets: [] }),
      discover: vi.fn(),
      start: vi.fn(),
      status: vi.fn().mockResolvedValue({ fresh: true, job: null }),
      streamEvents: vi.fn().mockReturnValue(new Promise<void>(() => undefined)),
    },
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

async function flush(times = 3): Promise<void> {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

async function mount(props: FirstRunGateProps): Promise<HTMLDivElement> {
  container = document.createElement('div');
  document.body.appendChild(container);
  await act(async () => {
    root = createRoot(container as HTMLDivElement);
    root.render(<FirstRunGate {...props} />);
  });
  await flush();
  return container;
}

function clickIncludes(el: HTMLElement, text: string): void {
  const btn = [...el.querySelectorAll('button')].find((b) => b.textContent?.includes(text));
  act(() => btn?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
}

describe('FirstRunGate', () => {
  it('offers exactly the two first-run choices', async () => {
    const el = await mount(makeProps());
    expect(el.textContent).toContain('Start fresh');
    expect(el.textContent).toContain('Recover my vault');
    expect(el.textContent).toContain('Starting fresh, or bringing a vault back');
  });

  it('"Start fresh" opens the existing onboarding identity step', async () => {
    const el = await mount(makeProps());
    clickIncludes(el, 'Start fresh');
    await flush();
    expect(el.textContent).toContain('Make yourself');
  });

  it('"Recover my vault" opens the recovery kit step', async () => {
    const el = await mount(makeProps());
    clickIncludes(el, 'Recover my vault');
    await flush();
    expect(el.textContent).toContain('Recover your');
    expect(el.querySelector('.textarea')).toBeTruthy();
  });

  it('"Back" from the recovery flow returns to the choice', async () => {
    const el = await mount(makeProps());
    clickIncludes(el, 'Recover my vault');
    await flush();
    clickIncludes(el, 'Back');
    await flush();
    expect(el.textContent).toContain('Starting fresh, or bringing a vault back');
  });
});
