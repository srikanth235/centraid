import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import IdentityHead from './IdentityHead.js';

// Successor to the sidebar's space switcher (#599, Decision 14). The point of
// these tests is what the row is NOT: it does not switch spaces, and it does
// not offer a gateway switch to a household with one gateway.

let root: Root | null = null;
let host: HTMLElement | null = null;
describe('IdentityHead suite', () => {
  beforeAll(() => {
    (globalThis as unknown as { CentraidTokens: unknown }).CentraidTokens = {
      tileFinish: () => ({
        background: '#111',
        boxShadow: 'none',
        glyphColor: '#fff',
      }),
    };
  });

  function render(el: React.ReactElement): HTMLElement {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    act(() => root!.render(el));
    return host;
  }

  afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    root = null;
    host = null;
  });

  describe(IdentityHead, () => {
    it('names the member’s own space and the gateway it lives on', () => {
      const el = render(
        <IdentityHead
          space={{ name: 'Priya', color: '#4E68DD', icon: 'Sparkle' }}
          gatewayLabel="This Mac"
          onOpenHousehold={() => {}}
        />,
      );
      expect(el.textContent).toContain('Priya');
      expect(el.textContent).toContain('This Mac');
    });

    it('opens Household — it is an identity row, not a space menu', () => {
      const onOpenHousehold = vi.fn<React.ComponentProps<typeof IdentityHead>['onOpenHousehold']>();
      const el = render(
        <IdentityHead
          space={{ name: 'Priya' }}
          gatewayLabel="This Mac"
          onOpenHousehold={onOpenHousehold}
        />,
      );
      const head = el.querySelector('button') as HTMLButtonElement;
      expect(head.getAttribute('aria-label')).toContain('Household');
      act(() => head.click());
      expect(onOpenHousehold).toHaveBeenCalledWith();
    });

    it('hides the gateway switch when there is nothing to switch between', () => {
      const el = render(
        <IdentityHead
          space={{ name: 'Priya' }}
          gatewayLabel="This Mac"
          onOpenHousehold={() => {}}
        />,
      );
      expect(el.querySelector('[aria-label="Switch gateway"]')).toBeNull();
    });

    it('offers the gateway switch with its own button when a second gateway exists', () => {
      const onSwitchGateway =
        vi.fn<NonNullable<React.ComponentProps<typeof IdentityHead>['onSwitchGateway']>>();
      const el = render(
        <IdentityHead
          space={{ name: 'Priya' }}
          gatewayLabel="Office"
          onOpenHousehold={() => {}}
          onSwitchGateway={onSwitchGateway}
          switcherOpen
        />,
      );
      const sw = el.querySelector('[aria-label="Switch gateway"]') as HTMLButtonElement;
      expect(sw).not.toBeNull();
      expect(sw.dataset.open).toBe('true');
      act(() => sw.click());
      expect(onSwitchGateway).toHaveBeenCalledWith(
        expect.objectContaining({ width: 0, height: 0 }),
      );
    });

    it('renders a quiet placeholder, disabled, until the scope registry resolves', () => {
      const el = render(<IdentityHead gatewayLabel="—" onOpenHousehold={() => {}} />);
      const head = el.querySelector('button') as HTMLButtonElement;
      expect(head.disabled).toBe(true);
      expect(el.textContent).toContain('Loading…');
    });
  });
});
