import { act } from 'react';
import { forEachSequentially } from '@centraid/test-kit/sequential';
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
    getGatewayAuth: async () => ({ baseUrl: 'https://gateway.test', token: 't' }),
  };
});

function makeProps(over: Partial<FirstRunGateProps> = {}): FirstRunGateProps {
  return {
    onOnboardingComplete: vi.fn<(...args: unknown[]) => unknown>(),
    host: 'desktop',
    ...over,
  };
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;
describe('FirstRunGate scenarios', () => {
  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    container?.remove();
    container = null;
    vi.restoreAllMocks();
  });

  async function flush(times = 3): Promise<void> {
    await forEachSequentially(Array.from({ length: times }), async () => {
      await act(async () => {
        await Promise.resolve();
      });
    });
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
    it('desktop offers exactly the two first-run choices — and no founding ceremony', async () => {
      const el = await mount(makeProps());
      expect(el.textContent).toContain('Start fresh on this Mac');
      expect(el.textContent).toContain('Connect with a ticket');
      expect(el.textContent).not.toContain('Create vault');
      expect(el.textContent).not.toContain('Restore vault');
      expect(el.querySelectorAll('button')).toHaveLength(2);
    });

    it('"Start fresh on this Mac" goes straight to the profile step', async () => {
      const el = await mount(makeProps());
      clickIncludes(el, 'Start fresh on this Mac');
      await flush();
      expect(el.textContent).toContain('Make yourself');
      expect(el.querySelector('[data-testid="onboarding-view"]')).toBeTruthy();
    });

    it('"Connect with a ticket" also starts at the profile step', async () => {
      const el = await mount(makeProps());
      clickIncludes(el, 'Connect with a ticket');
      await flush();
      expect(el.textContent).toContain('Make yourself');
    });

    it('"Back" from a chosen path returns to the chooser', async () => {
      const el = await mount(makeProps());
      clickIncludes(el, 'Connect with a ticket');
      await flush();
      clickIncludes(el, 'Back');
      await flush();
      expect(el.querySelector('[data-testid="first-run-choice"]')).toBeTruthy();
    });

    it('web never shows the chooser — the ticket path is the only path', async () => {
      const el = await mount(makeProps({ host: 'web' }));
      expect(el.querySelector('[data-testid="first-run-choice"]')).toBeNull();
      expect(el.textContent).toContain('Make yourself');
      expect(el.textContent).not.toContain('this Mac');
      // No chooser to go back to, so no back affordance either.
      expect([...el.querySelectorAll('button')].some((b) => b.textContent === 'Back')).toBe(false);
    });
  });
});
