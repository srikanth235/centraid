import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SettingsLayoutBridgeProps } from '../screen-contracts.js';
import SettingsLayoutScreen from './SettingsLayoutScreen.js';

function makeProps(over: Partial<SettingsLayoutBridgeProps> = {}): SettingsLayoutBridgeProps {
  return {
    density: 'regular',
    cardVariant: 'outlined',
    sidebarOpen: true,
    onSetDensity: vi.fn(),
    onSetCards: vi.fn(),
    onSetSidebar: vi.fn(),
    ...over,
  };
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  vi.clearAllMocks();
});
function mount(props: SettingsLayoutBridgeProps): HTMLDivElement {
  container = document.createElement('div');
  document.body.appendChild(container);
  act(() => {
    root = createRoot(container as HTMLDivElement);
    root.render(<SettingsLayoutScreen {...props} />);
  });
  return container;
}

const seg = (el: HTMLElement, group: number): HTMLButtonElement[] =>
  [...el.querySelectorAll('.seg')[group]!.querySelectorAll('button')] as HTMLButtonElement[];

describe('SettingsLayoutScreen', () => {
  it('renders density (3) + cards (3) segmented + a sidebar switch, with active reflecting props', () => {
    const el = mount(makeProps());
    expect(el.querySelectorAll('.seg').length).toBe(2);
    expect(seg(el, 0).length).toBe(3);
    expect(seg(el, 1).length).toBe(3);
    expect(seg(el, 0).find((b) => b.textContent === 'regular')?.dataset.active).toBe('true');
    expect((el.querySelector('.cd-switch') as HTMLElement).dataset.on).toBe('true');
  });

  it('changes density, cards, and the sidebar toggle', () => {
    const props = makeProps();
    const el = mount(props);
    act(() =>
      seg(el, 0)
        .find((b) => b.textContent === 'compact')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true })),
    );
    expect(props.onSetDensity).toHaveBeenCalledWith('compact');
    act(() =>
      seg(el, 1)
        .find((b) => b.textContent === 'elevated')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true })),
    );
    expect(props.onSetCards).toHaveBeenCalledWith('elevated');
    act(() =>
      (el.querySelector('.cd-switch') as HTMLButtonElement).dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      ),
    );
    expect(props.onSetSidebar).toHaveBeenCalledWith(false);
  });
});
