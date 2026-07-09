import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PaletteBridgeProps, PaletteGroupDTO } from '../screen-contracts.js';
import PaletteScreen from './PaletteScreen.js';

const buildRun = vi.fn();
const browseRun = vi.fn();
const appRun = vi.fn();

function groupsFor(query: string): PaletteGroupDTO[] {
  const build: PaletteGroupDTO = {
    group: 'Build',
    items: [
      {
        label: query ? `Build ${query}` : 'Build a new app',
        iconHtml: '<svg></svg>',
        variant: 'action',
        accent: true,
        kbd: '↵',
        run: buildRun,
      },
      { label: 'Browse templates', iconHtml: '', variant: 'action', run: browseRun },
    ],
  };
  const apps: PaletteGroupDTO = {
    group: 'Apps · 1',
    items: [
      {
        label: 'Todos',
        sub: 'A todo app',
        iconHtml: '<svg></svg>',
        variant: 'app',
        tile: { background: '#000', glyphColor: '#fff' },
        meta: '2h',
        run: appRun,
      },
    ],
  };
  return [build, apps];
}

function makeProps(over: Partial<PaletteBridgeProps> = {}): PaletteBridgeProps {
  return { buildGroups: vi.fn(groupsFor), onClose: vi.fn(), ...over };
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
function mount(props: PaletteBridgeProps): HTMLDivElement {
  container = document.createElement('div');
  document.body.appendChild(container);
  act(() => {
    root = createRoot(container as HTMLDivElement);
    root.render(<PaletteScreen {...props} />);
  });
  return container;
}

const rows = (el: HTMLElement): HTMLButtonElement[] =>
  [...el.querySelectorAll('.row')] as HTMLButtonElement[];

describe('PaletteScreen', () => {
  it('renders grouped rows with the first row active', () => {
    const el = mount(makeProps());
    expect(el.querySelectorAll('.group').length).toBe(2);
    expect(rows(el).length).toBe(3);
    expect(rows(el)[0]?.dataset.active).toBe('true');
    // app-variant row carries the gradient tile + injected icon svg
    expect(el.querySelector('.rowTile')).toBeTruthy();
    expect(el.querySelector('.rowTile svg')).toBeTruthy();
  });

  it('moves the active row with ArrowDown and runs it on Enter', () => {
    const el = mount(makeProps());
    const input = el.querySelector('.input') as HTMLInputElement;
    act(() =>
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })),
    );
    expect(rows(el)[1]?.dataset.active).toBe('true');
    act(() => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    expect(browseRun).toHaveBeenCalledTimes(1);
    expect(buildRun).not.toHaveBeenCalled();
  });

  it('runs a row on click', () => {
    const el = mount(makeProps());
    act(() => rows(el)[2]?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(appRun).toHaveBeenCalledTimes(1);
  });

  it('recomputes groups from the query and passes it to buildGroups', () => {
    const props = makeProps();
    const el = mount(props);
    const input = el.querySelector('.input') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(
      globalThis.HTMLInputElement.prototype,
      'value',
    )?.set;
    act(() => {
      setter?.call(input, 'notes');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(props.buildGroups).toHaveBeenCalledWith('notes');
    expect(el.textContent).toContain('Build notes');
  });

  it('closes on Escape and on backdrop click', () => {
    const props = makeProps();
    const el = mount(props);
    const input = el.querySelector('.input') as HTMLInputElement;
    act(() => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(props.onClose).toHaveBeenCalledTimes(1);
    const backdrop = el.querySelector('.backdrop') as HTMLElement;
    act(() => backdrop.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(props.onClose).toHaveBeenCalledTimes(2);
  });
});
