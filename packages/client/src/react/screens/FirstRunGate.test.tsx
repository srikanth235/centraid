import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import FirstRunGate, { type FirstRunGateProps } from './FirstRunGate.js';

// FirstRunGate pulls in OnboardingScreen (→ ConnectFlow → gateway-client),
// which reaches gateway-client-core's module-load window.CentraidApi listeners.
// `vi.hoisted` is lifted above the import, so this stub is installed first.
vi.hoisted(() => {
  (window as unknown as { CentraidApi: Record<string, unknown> }).CentraidApi = {
    onGatewayChanged: () => () => undefined,
    onVaultChanged: () => () => undefined,
    getGatewayAuth: async () => ({
      baseUrl: 'https://gateway.test',
      token: 't',
    }),
  };
});

function makeProps(over: Partial<FirstRunGateProps> = {}): FirstRunGateProps {
  return {
    onOnboardingComplete: vi.fn<FirstRunGateProps['onOnboardingComplete']>(),
    onFoundingComplete: vi.fn<FirstRunGateProps['onFoundingComplete']>(),
    gatewayStatus: 'uninitialized',
    founding: {
      initialize: vi.fn<FirstRunGateProps['founding']['initialize']>(),
      verify: vi.fn<FirstRunGateProps['founding']['verify']>(),
      restore: vi.fn<FirstRunGateProps['founding']['restore']>(),
    },
    ...over,
  };
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;
describe('screens/FirstRunGate', () => {
  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    container?.remove();
    container = null;
    vi.restoreAllMocks();
  });

  async function flush(times = 3): Promise<void> {
    const flushNext = async (index: number): Promise<void> => {
      if (index >= times) return;
      await act(async () => {});
      return flushNext(index + 1);
    };
    return flushNext(0);
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

  describe(FirstRunGate, () => {
    it('offers exactly the two first-run choices', async () => {
      const el = await mount(makeProps());
      expect(el.textContent).toContain('Create vault');
      expect(el.textContent).toContain('Restore vault');
      expect(el.textContent).toContain('Starting fresh, or bringing a vault back');
    });

    it('"Create vault" opens the founding ceremony', async () => {
      const el = await mount(makeProps());
      clickIncludes(el, 'Create vault');
      await flush();
      expect(el.textContent).toContain('Create your vault');
      expect(el.textContent).toContain('Recovery-kit password');
    });

    it('"Restore vault" opens the restore peer of the same ceremony', async () => {
      const el = await mount(makeProps());
      clickIncludes(el, 'Restore vault');
      await flush();
      expect(el.textContent).toContain('Restore your vault');
      expect(el.textContent).toContain('Storage-provider key');
    });

    it('"Back" from founding returns to the choice', async () => {
      const el = await mount(makeProps());
      clickIncludes(el, 'Restore vault');
      await flush();
      clickIncludes(el, 'Back');
      await flush();
      expect(el.textContent).toContain('Starting fresh, or bringing a vault back');
    });

    it('never shows Create / Restore for an already-founded gateway', async () => {
      const el = await mount(makeProps({ gatewayStatus: 'ready' }));
      expect(el.textContent).toContain('Make yourself');
      expect(el.textContent).not.toContain('Create vault');
      expect(el.textContent).not.toContain('Restore vault');
    });
  });
});
