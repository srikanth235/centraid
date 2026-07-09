import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import OnboardingScreen, { type OnboardingScreenProps } from './OnboardingScreen.js';

let root: Root | null = null;
let container: HTMLDivElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  vi.clearAllMocks();
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

describe('OnboardingScreen', () => {
  it('renders the welcome card, 8 swatches, and a disabled CTA until a name is entered', () => {
    const el = mount({ onComplete: vi.fn() });
    expect(el.textContent).toContain('Make yourself');
    expect(el.querySelectorAll('.swatch').length).toBe(8);
    const cta = el.querySelector('.cta') as HTMLButtonElement;
    expect(cta.disabled).toBe(true);
    typeName(el.querySelector('.input') as HTMLInputElement, 'Ada Lovelace');
    expect((el.querySelector('.cta') as HTMLButtonElement).disabled).toBe(false);
    // initials reflect the name
    expect(el.querySelector('.initials')?.textContent).toBe('AL');
  });

  it('selects a swatch on click', () => {
    const el = mount({ onComplete: vi.fn() });
    const swatch = el.querySelectorAll('.swatch')[3] as HTMLButtonElement;
    act(() => swatch.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(swatch.dataset.selected).toBe('true');
    expect(el.querySelectorAll('[data-selected="true"]').length).toBe(1);
  });

  it('submits the trimmed name + selected color via onComplete', () => {
    const onComplete = vi.fn().mockResolvedValue(undefined);
    const el = mount({ onComplete });
    typeName(el.querySelector('.input') as HTMLInputElement, '  Grace  ');
    const swatch = el.querySelectorAll('.swatch')[2] as HTMLButtonElement;
    act(() => swatch.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    const cta = el.querySelector('.cta') as HTMLButtonElement;
    act(() => cta.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(onComplete).toHaveBeenCalledWith({ displayName: 'Grace', avatarColor: '#E36AD2' });
  });

  it('surfaces an error inline when onComplete rejects', async () => {
    const onComplete = vi.fn().mockRejectedValue(new Error('nope'));
    const el = mount({ onComplete });
    typeName(el.querySelector('.input') as HTMLInputElement, 'X');
    const cta = el.querySelector('.cta') as HTMLButtonElement;
    await act(async () => {
      cta.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    expect(el.querySelector('.error')?.textContent).toContain('nope');
  });
});
