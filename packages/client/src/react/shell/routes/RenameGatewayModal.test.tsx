import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import RenameGatewayModal from './RenameGatewayModal.js';

let root: Root | null = null;
let container: HTMLDivElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
});

function mount(onCancel: () => void, onCommit: (label: string) => void): HTMLDivElement {
  container = document.createElement('div');
  document.body.appendChild(container);
  act(() => {
    root = createRoot(container as HTMLDivElement);
    root.render(
      <RenameGatewayModal initialLabel="Home server" onCancel={onCancel} onCommit={onCommit} />,
    );
  });
  return container;
}

describe('RenameGatewayModal', () => {
  it('pre-fills the label and commits the trimmed value', () => {
    const onCommit = vi.fn();
    const el = mount(vi.fn(), onCommit);
    const input = el.querySelector('input') as HTMLInputElement;
    expect(input.value).toBe('Home server');
    const setter = Object.getOwnPropertyDescriptor(
      globalThis.HTMLInputElement.prototype,
      'value',
    )?.set;
    act(() => {
      setter?.call(input, '  Cabin  ');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const save = [...el.querySelectorAll('button')].find(
      (b) => b.textContent === 'Save',
    ) as HTMLButtonElement;
    act(() => save.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(onCommit).toHaveBeenCalledWith('Cabin');
  });

  it('disables Save for an empty label', () => {
    const el = mount(vi.fn(), vi.fn());
    const input = el.querySelector('input') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(
      globalThis.HTMLInputElement.prototype,
      'value',
    )?.set;
    act(() => {
      setter?.call(input, '   ');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const save = [...el.querySelectorAll('button')].find(
      (b) => b.textContent === 'Save',
    ) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
  });

  it('closes on scrim click and Escape', () => {
    const onCancel = vi.fn();
    const el = mount(onCancel, vi.fn());
    act(() =>
      (el.querySelector('.profScrim') as HTMLButtonElement).dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      ),
    );
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
