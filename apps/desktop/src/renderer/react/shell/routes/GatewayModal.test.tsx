import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import GatewayModal from './GatewayModal.js';

beforeEach(() => {
  (globalThis as unknown as { CentraidApi: unknown }).CentraidApi = {
    addGateway: vi.fn(),
    redeemGatewayPairing: vi.fn(() => Promise.resolve({ ok: false, error: 'unreachable' })),
    setActiveGateway: vi.fn(),
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
function mount(onCancel: () => void, onConnected: () => void): HTMLDivElement {
  container = document.createElement('div');
  document.body.appendChild(container);
  act(() => {
    root = createRoot(container as HTMLDivElement);
    root.render(<GatewayModal onCancel={onCancel} onConnected={onConnected} />);
  });
  return container;
}

describe('GatewayModal', () => {
  it('renders the "Add gateway" dialog with the pairing form inside', () => {
    const el = mount(vi.fn(), vi.fn());
    expect(el.querySelector('[role="dialog"]')).toBeTruthy();
    expect(el.textContent).toContain('Add gateway');
    expect(el.querySelector('textarea')).toBeTruthy();
  });

  it('closes on scrim click and on the header close button', () => {
    const onCancel = vi.fn();
    const el = mount(onCancel, vi.fn());
    act(() => {
      (el.querySelector('.profScrim') as HTMLButtonElement).dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      );
    });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('closes on Escape', () => {
    const onCancel = vi.fn();
    mount(onCancel, vi.fn());
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Escape' }));
    });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
