import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import OnboardingScreen, { type OnboardingScreenProps } from './OnboardingScreen.js';

vi.mock(import('../../gateway-client.js'), () => ({
  listVaults: () => listVaultsMock(),
}));

const listVaultsMock = vi.fn<typeof import('../../gateway-client.js').listVaults>();
const getSettings = vi.fn<typeof window.CentraidApi.getSettings>();
const setActiveGateway = vi.fn<typeof window.CentraidApi.setActiveGateway>();
const setActiveVault = vi.fn<typeof window.CentraidApi.setActiveVault>();
const createVault = vi.fn<typeof window.CentraidApi.createVault>();
const redeemGatewayPairing = vi.fn<typeof window.CentraidApi.redeemGatewayPairing>();
const testGatewayConnection = vi.fn<typeof window.CentraidApi.testGatewayConnection>();

function currentSettings(): Awaited<ReturnType<typeof window.CentraidApi.getSettings>> {
  return {
    activeGatewayId: 'local',
    activeGatewayKind: 'local',
    activeGatewayLabel: 'This Mac',
    activeProfileDisplayName: 'This Mac',
    activeProfileAvatarColor: '#4E68DD',
    gatewayUrl: 'http://127.0.0.1:49152',
  };
}

describe('screens/OnboardingScreen', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listVaultsMock.mockResolvedValue([
      { vaultId: 'a', name: 'Personal', ownerPartyId: 'party-personal' },
    ]);
    getSettings.mockResolvedValue(currentSettings());
    setActiveGateway.mockResolvedValue(currentSettings());
    setActiveVault.mockResolvedValue(currentSettings());
    createVault.mockResolvedValue({ vaultId: 'new1' });
    (globalThis as unknown as { CentraidApi: unknown }).CentraidApi = {
      addGateway: vi.fn<typeof window.CentraidApi.addGateway>(),
      createVault,
      getSettings,
      redeemGatewayPairing,
      setActiveGateway,
      setActiveVault,
      testGatewayConnection,
    };
  });

  let root: Root | null = null;
  let container: HTMLDivElement | null = null;
  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    container?.remove();
    container = null;
  });

  function mount(props: OnboardingScreenProps): HTMLDivElement {
    container = document.createElement('div');
    document.body.appendChild(container);
    act(() => {
      root = createRoot(container as HTMLDivElement);
      root.render(<OnboardingScreen {...props} />);
    });
    return container;
  }

  function typeName(input: HTMLInputElement, value: string): void {
    const setter = Object.getOwnPropertyDescriptor(
      globalThis.HTMLInputElement.prototype,
      'value',
    )?.set;
    act(() => {
      setter?.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }

  function click(el: Element | null | undefined): void {
    act(() => (el as HTMLButtonElement)?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  }

  // Swatches and method cards are native radios inside a styled <label> that
  // carries the visible text / state attributes (issue #573).
  function radioIn(el: Element | null | undefined): HTMLInputElement | null {
    return el?.querySelector<HTMLInputElement>('input[type="radio"]') ?? null;
  }

  function radioLabelled(el: HTMLElement, text: string): HTMLInputElement | null {
    return radioIn([...el.querySelectorAll('label')].find((l) => l.textContent?.includes(text)));
  }

  async function flush(times = 3): Promise<void> {
    const flushNext = async (index: number): Promise<void> => {
      if (index >= times) return;
      await act(async () => {});
      return flushNext(index + 1);
    };
    return flushNext(0);
  }

  describe(OnboardingScreen, () => {
    it('renders the identity step with 8 swatches and a disabled CTA until a name is entered', () => {
      const el = mount({
        onComplete: vi.fn<OnboardingScreenProps['onComplete']>(),
      });
      expect(el.textContent).toContain('Make yourself');
      expect(el.querySelectorAll('.swatch')).toHaveLength(8);
      const cta = el.querySelector('.cta') as HTMLButtonElement;
      expect(cta.disabled).toBe(true);
      typeName(el.querySelector('.input') as HTMLInputElement, 'Ada Lovelace');
      expect((el.querySelector('.cta') as HTMLButtonElement).disabled).toBe(false);
      expect(el.querySelector('.initials')?.textContent).toBe('AL');
    });

    it('selects a swatch on click', () => {
      const el = mount({
        onComplete: vi.fn<OnboardingScreenProps['onComplete']>(),
      });
      const swatch = el.querySelectorAll('.swatch')[3] as HTMLLabelElement;
      click(radioIn(swatch));
      expect(swatch.dataset.selected).toBe('true');
      expect(el.querySelectorAll('[data-selected="true"]')).toHaveLength(1);
    });

    it('Continue moves to step 2, showing the three method cards', () => {
      const el = mount({
        onComplete: vi.fn<OnboardingScreenProps['onComplete']>(),
      });
      typeName(el.querySelector('.input') as HTMLInputElement, 'Ada');
      click(el.querySelector('.cta'));
      expect(el.textContent).toContain('Where does your');
      expect(el.querySelectorAll('input[type="radio"]')).toHaveLength(3);
      expect(el.querySelector('.cta')).toBeNull();
    });

    it('"Start over" from step 2 returns to the identity step', () => {
      const el = mount({
        onComplete: vi.fn<OnboardingScreenProps['onComplete']>(),
      });
      typeName(el.querySelector('.input') as HTMLInputElement, 'Ada');
      click(el.querySelector('.cta'));
      click([...el.querySelectorAll('button')].find((b) => b.textContent === 'Start over'));
      expect(el.textContent).toContain('Make yourself');
      expect(el.querySelector('.cta')).toBeTruthy();
    });

    it('picking "This Mac" with exactly one existing vault completes onboarding automatically', async () => {
      const onComplete = vi.fn<OnboardingScreenProps['onComplete']>();
      const el = mount({ onComplete });
      typeName(el.querySelector('.input') as HTMLInputElement, '  Grace  ');
      const swatch = el.querySelectorAll('.swatch')[2] as HTMLLabelElement;
      click(radioIn(swatch));
      click(el.querySelector('.cta'));
      click(radioLabelled(el, 'This Mac'));
      await flush(4);
      expect(onComplete).toHaveBeenCalledWith({
        avatarColor: '#E36AD2',
        displayName: 'Grace',
        gatewayId: 'local',
      });
    });

    it('completing the "Existing gateway" ticket flow finishes onboarding with the connected gatewayId', async () => {
      vi.spyOn(
        (
          globalThis as unknown as {
            CentraidApi: {
              testGatewayConnection: (...args: unknown[]) => Promise<unknown>;
            };
          }
        ).CentraidApi,
        'testGatewayConnection',
      ).mockResolvedValue({
        ok: true,
        stages: [],
        ticket: { expiresAt: '', gatewayEndpointId: '', vaultName: 'Office' },
      });
      redeemGatewayPairing.mockResolvedValue({
        gatewayId: 'gw1',
        ok: true,
        vaultId: 'v1',
        vaultName: 'Office',
      });
      const onComplete = vi.fn<OnboardingScreenProps['onComplete']>().mockResolvedValue(undefined);
      const el = mount({ onComplete });
      typeName(el.querySelector('.input') as HTMLInputElement, 'Ada');
      click(el.querySelector('.cta'));

      click(radioLabelled(el, 'Existing gateway'));
      await flush();
      const textarea = el.querySelector('textarea') as HTMLTextAreaElement;
      const setter = Object.getOwnPropertyDescriptor(
        globalThis.HTMLTextAreaElement.prototype,
        'value',
      )?.set;
      act(() => {
        setter?.call(textarea, 'a-ticket');
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
      });
      click([...el.querySelectorAll('button')].find((b) => b.textContent === 'Continue'));
      await flush(3);
      click([...el.querySelectorAll('button')].find((b) => b.textContent === 'Continue'));
      await flush();
      click([...el.querySelectorAll('button')].find((b) => b.textContent === 'Enter Centraid'));
      await flush(3);
      expect(redeemGatewayPairing).toHaveBeenCalledWith({
        label: undefined,
        rememberDevice: false,
        ticket: 'a-ticket',
      });
      expect(onComplete).toHaveBeenCalledWith({
        avatarColor: expect.any(String),
        displayName: 'Ada',
        gatewayId: 'gw1',
      });
    });

    it('surfaces an error inline when onComplete rejects', async () => {
      const onComplete = vi
        .fn<OnboardingScreenProps['onComplete']>()
        .mockRejectedValue(new Error('nope'));
      const el = mount({ onComplete });
      typeName(el.querySelector('.input') as HTMLInputElement, 'X');
      click(el.querySelector('.cta'));
      await flush();
      click(radioLabelled(el, 'This Mac'));
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
      act(() => undefined);
      expect(el.querySelector('.error')?.textContent).toContain('nope');
    });
  });
});
