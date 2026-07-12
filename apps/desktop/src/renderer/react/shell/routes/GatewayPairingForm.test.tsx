import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import GatewayPairingForm, { type GatewayPairingFormProps } from './GatewayPairingForm.js';

const redeemGatewayPairing = vi.fn();
const addGateway = vi.fn();
const setActiveGateway = vi.fn(() => Promise.resolve());

beforeEach(() => {
  redeemGatewayPairing.mockReset();
  addGateway.mockReset();
  setActiveGateway.mockClear();
  (globalThis as unknown as { CentraidApi: unknown }).CentraidApi = {
    addGateway,
    redeemGatewayPairing,
    setActiveGateway,
  };
});

let root: Root | null = null;
let container: HTMLDivElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  vi.clearAllMocks();
});
function mount(props: Partial<GatewayPairingFormProps> = {}): HTMLDivElement {
  container = document.createElement('div');
  document.body.appendChild(container);
  act(() => {
    root = createRoot(container as HTMLDivElement);
    root.render(<GatewayPairingForm onConnected={vi.fn()} {...props} />);
  });
  return container;
}

function setValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto =
    el instanceof HTMLTextAreaElement
      ? globalThis.HTMLTextAreaElement.prototype
      : globalThis.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  act(() => {
    setter?.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function click(el: Element): void {
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('GatewayPairingForm', () => {
  it('disables Connect until a ticket is entered, then submits ticket + label', async () => {
    redeemGatewayPairing.mockResolvedValue({
      gatewayId: 'gw1',
      ok: true,
      vaultId: 'v1',
      vaultName: 'Home',
    });
    const onConnected = vi.fn();
    const el = mount({ onConnected });
    const connectBtn = [...el.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Connect'),
    ) as HTMLButtonElement;
    expect(connectBtn.disabled).toBe(true);

    setValue(el.querySelector('textarea') as HTMLTextAreaElement, 'my-ticket');
    expect(connectBtn.disabled).toBe(false);

    const labelInput = el.querySelectorAll('input')[0] as HTMLInputElement;
    setValue(labelInput, 'My gateway');

    click(connectBtn);
    await flush();

    expect(redeemGatewayPairing).toHaveBeenCalledWith({
      label: 'My gateway',
      ticket: 'my-ticket',
    });
    expect(onConnected).toHaveBeenCalledWith({
      gatewayId: 'gw1',
      label: 'Home',
      ok: true,
      vaultId: 'v1',
    });
  });

  it('surfaces the friendly error copy inline on failure without calling onConnected', async () => {
    redeemGatewayPairing.mockResolvedValue({
      error: 'ticket_expired',
      message: 'raw',
      ok: false,
    });
    const onConnected = vi.fn();
    const el = mount({ onConnected });
    setValue(el.querySelector('textarea') as HTMLTextAreaElement, 'stale-ticket');
    const connectBtn = [...el.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Connect'),
    ) as HTMLButtonElement;
    click(connectBtn);
    await flush();

    expect(onConnected).not.toHaveBeenCalled();
    expect(el.textContent).toContain('This ticket has expired — ask for a new one.');
  });

  it('advanced "Connect by URL" + bearer token hides the ticket field and requires url+token', async () => {
    addGateway.mockResolvedValue({ displayName: 'Landlord', id: 'gw2', label: 'Landlord' });
    const onConnected = vi.fn();
    const el = mount({ onConnected });

    // Open the <details> and switch to the token credential.
    const details = el.querySelector('details') as HTMLDetailsElement;
    details.open = true;
    details.dispatchEvent(new Event('toggle', { bubbles: true }));
    const tokenRadio = [...el.querySelectorAll('[role="radio"]')].find((b) =>
      b.textContent?.includes('Bearer token'),
    ) as HTMLButtonElement;
    click(tokenRadio);

    // Ticket textarea is gone once the token credential is selected.
    expect(el.querySelector('textarea')).toBeNull();

    const urlInput = [...el.querySelectorAll('input')].find(
      (i) => i.getAttribute('placeholder') === 'https://gateway.example.com',
    ) as HTMLInputElement;
    const tokenInput = el.querySelector('input[type="password"]') as HTMLInputElement;
    const connectBtn = [...el.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Connect'),
    ) as HTMLButtonElement;
    expect(connectBtn.disabled).toBe(true);

    setValue(urlInput, 'https://landlord.example');
    setValue(tokenInput, 'sekret');
    expect(connectBtn.disabled).toBe(false);

    click(connectBtn);
    await flush();

    expect(addGateway).toHaveBeenCalledWith({
      label: 'https://landlord.example',
      token: 'sekret',
      url: 'https://landlord.example',
    });
    expect(setActiveGateway).toHaveBeenCalledWith({ id: 'gw2' });
    expect(onConnected).toHaveBeenCalledWith({ gatewayId: 'gw2', label: 'Landlord', ok: true });
  });

  it('renders no Cancel button when onCancel is omitted, and fires it when provided', () => {
    const onCancel = vi.fn();
    const el = mount({ onCancel });
    const cancelBtn = [...el.querySelectorAll('button')].find(
      (b) => b.textContent === 'Cancel',
    ) as HTMLButtonElement;
    expect(cancelBtn).toBeTruthy();
    click(cancelBtn);
    expect(onCancel).toHaveBeenCalledTimes(1);

    act(() => root?.unmount());
    container?.remove();
    const el2 = mount({});
    expect([...el2.querySelectorAll('button')].some((b) => b.textContent === 'Cancel')).toBe(false);
  });
});
