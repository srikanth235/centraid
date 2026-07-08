import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OnboardingBridgeProps } from '../bridge.js';
import OnboardingScreen from './OnboardingScreen.js';

let root: Root | null = null;
let container: HTMLDivElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  vi.clearAllMocks();
});
function mount(props: OnboardingBridgeProps): HTMLDivElement {
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

describe('OnboardingScreen', () => {
  it('renders the welcome card, 8 swatches, and a disabled CTA until a name is entered', () => {
    const el = mount({ onComplete: vi.fn() });
    expect(el.textContent).toContain('Make yourself');
    expect(el.querySelectorAll('.cd-onb-swatch').length).toBe(8);
    const cta = el.querySelector('.cd-onb-cta') as HTMLButtonElement;
    expect(cta.disabled).toBe(true);
    typeName(el.querySelector('.cd-onb-input') as HTMLInputElement, 'Ada Lovelace');
    expect((el.querySelector('.cd-onb-cta') as HTMLButtonElement).disabled).toBe(false);
    // initials reflect the name
    expect(el.querySelector('.cd-onb-initials')?.textContent).toBe('AL');
  });

  it('selects a swatch on click', () => {
    const el = mount({ onComplete: vi.fn() });
    const swatch = el.querySelectorAll('.cd-onb-swatch')[3] as HTMLButtonElement;
    act(() => swatch.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(swatch.dataset.selected).toBe('true');
    expect(el.querySelectorAll('[data-selected="true"]').length).toBe(1);
  });

  it('submits the trimmed name + selected color via onComplete', () => {
    const onComplete = vi.fn().mockResolvedValue(undefined);
    const el = mount({ onComplete });
    typeName(el.querySelector('.cd-onb-input') as HTMLInputElement, '  Grace  ');
    const swatch = el.querySelectorAll('.cd-onb-swatch')[2] as HTMLButtonElement;
    act(() => swatch.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    const cta = el.querySelector('.cd-onb-cta') as HTMLButtonElement;
    act(() => cta.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(onComplete).toHaveBeenCalledWith({ displayName: 'Grace', avatarColor: '#E36AD2' });
  });

  it('surfaces an error inline when onComplete rejects', async () => {
    const onComplete = vi.fn().mockRejectedValue(new Error('nope'));
    const el = mount({ onComplete });
    typeName(el.querySelector('.cd-onb-input') as HTMLInputElement, 'X');
    const cta = el.querySelector('.cd-onb-cta') as HTMLButtonElement;
    await act(async () => {
      cta.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    expect(el.querySelector('.cd-onb-error')?.textContent).toContain('nope');
  });
});
