import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import OnboardingScreen, { type OnboardingScreenProps } from './OnboardingScreen.js';

vi.mock('../../gateway-client.js', () => ({
  listVaults: () => listVaultsMock(),
}));

const listVaultsMock = vi.fn();
const getSettings = vi.fn();
const setActiveGateway = vi.fn();
const setActiveVault = vi.fn();
const createVault = vi.fn();
const redeemGatewayPairing = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  listVaultsMock.mockResolvedValue([{ vaultId: 'a', name: 'Personal' }]);
  getSettings.mockResolvedValue({ activeGatewayId: 'local' });
  setActiveGateway.mockResolvedValue({});
  setActiveVault.mockResolvedValue({});
  createVault.mockResolvedValue({ vaultId: 'new1' });
  (globalThis as unknown as { CentraidApi: unknown }).CentraidApi = {
    addGateway: vi.fn(),
    createVault,
    getSettings,
    redeemGatewayPairing,
    setActiveGateway,
    setActiveVault,
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

async function flush(times = 3): Promise<void> {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

describe('OnboardingScreen', () => {
  it('renders the identity step with 8 swatches and a disabled CTA until a name is entered', () => {
    const el = mount({ onComplete: vi.fn() });
    expect(el.textContent).toContain('Make yourself');
    expect(el.querySelectorAll('.swatch').length).toBe(8);
    const cta = el.querySelector('.cta') as HTMLButtonElement;
    expect(cta.disabled).toBe(true);
    typeName(el.querySelector('.input') as HTMLInputElement, 'Ada Lovelace');
    expect((el.querySelector('.cta') as HTMLButtonElement).disabled).toBe(false);
    expect(el.querySelector('.initials')?.textContent).toBe('AL');
  });

  it('selects a swatch on click', () => {
    const el = mount({ onComplete: vi.fn() });
    const swatch = el.querySelectorAll('.swatch')[3] as HTMLButtonElement;
    click(swatch);
    expect(swatch.dataset.selected).toBe('true');
    expect(el.querySelectorAll('[data-selected="true"]').length).toBe(1);
  });

  it('Continue moves to step 2, showing the three method cards', () => {
    const el = mount({ onComplete: vi.fn() });
    typeName(el.querySelector('.input') as HTMLInputElement, 'Ada');
    click(el.querySelector('.cta'));
    expect(el.textContent).toContain('Where does your');
    expect(el.querySelectorAll('[role="radio"]').length).toBe(3);
    expect(el.querySelector('.cta')).toBeNull();
  });

  it('"Start over" from step 2 returns to the identity step', () => {
    const el = mount({ onComplete: vi.fn() });
    typeName(el.querySelector('.input') as HTMLInputElement, 'Ada');
    click(el.querySelector('.cta'));
    click([...el.querySelectorAll('button')].find((b) => b.textContent === 'Start over'));
    expect(el.textContent).toContain('Make yourself');
    expect(el.querySelector('.cta')).toBeTruthy();
  });

  it('picking "This Mac" with exactly one existing vault completes onboarding automatically', async () => {
    const onComplete = vi.fn().mockResolvedValue(undefined);
    const el = mount({ onComplete });
    typeName(el.querySelector('.input') as HTMLInputElement, '  Grace  ');
    const swatch = el.querySelectorAll('.swatch')[2] as HTMLButtonElement;
    click(swatch);
    click(el.querySelector('.cta'));
    const thisMac = [...el.querySelectorAll('[role="radio"]')].find((r) =>
      r.textContent?.includes('This Mac'),
    );
    click(thisMac);
    await flush(4);
    expect(onComplete).toHaveBeenCalledWith({
      avatarColor: '#E36AD2',
      displayName: 'Grace',
      gatewayId: 'local',
    });
  });

  it('completing the "Existing gateway" ticket flow finishes onboarding with the connected gatewayId', async () => {
    (
      globalThis as unknown as { CentraidApi: { testGatewayConnection: unknown } }
    ).CentraidApi.testGatewayConnection = vi.fn().mockResolvedValue({
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
    const onComplete = vi.fn().mockResolvedValue(undefined);
    const el = mount({ onComplete });
    typeName(el.querySelector('.input') as HTMLInputElement, 'Ada');
    click(el.querySelector('.cta'));

    const gatewayCard = [...el.querySelectorAll('[role="radio"]')].find((r) =>
      r.textContent?.includes('Existing gateway'),
    );
    click(gatewayCard);
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
    const onComplete = vi.fn().mockRejectedValue(new Error('nope'));
    const el = mount({ onComplete });
    typeName(el.querySelector('.input') as HTMLInputElement, 'X');
    click(el.querySelector('.cta'));
    const thisMac = [...el.querySelectorAll('[role="radio"]')].find((r) =>
      r.textContent?.includes('This Mac'),
    );
    click(thisMac);
    await flush(4);
    expect(el.querySelector('.error')?.textContent).toContain('nope');
  });
});
