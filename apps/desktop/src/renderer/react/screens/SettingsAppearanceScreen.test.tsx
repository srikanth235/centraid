import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { THEME_PRESETS } from '@centraid/design-tokens';
import type { SettingsAppearanceBridgeProps } from '../screen-contracts.js';
import SettingsAppearanceScreen from './SettingsAppearanceScreen.js';

function makeProps(
  over: Partial<SettingsAppearanceBridgeProps> = {},
): SettingsAppearanceBridgeProps {
  return {
    theme: 'light',
    coolBlueCast: false,
    accent: 'teal',
    tileVariant: 'solid',
    onSetTheme: vi.fn(),
    onSetCoolCast: vi.fn(),
    onSetAccent: vi.fn(),
    onSetTile: vi.fn(),
    onMatchSystem: vi.fn().mockReturnValue('dark'),
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
function mount(props: SettingsAppearanceBridgeProps): HTMLDivElement {
  container = document.createElement('div');
  document.body.appendChild(container);
  act(() => {
    root = createRoot(container as HTMLDivElement);
    root.render(<SettingsAppearanceScreen {...props} />);
  });
  return container;
}

describe('SettingsAppearanceScreen', () => {
  it('renders a theme card per preset, 5 accents, 4 tile treatments, and 4 preview tiles', () => {
    const el = mount(makeProps());
    expect(el.querySelectorAll('.themeCard').length).toBe(THEME_PRESETS.length);
    expect(el.querySelectorAll('.cd-swatch').length).toBe(5);
    expect(el.querySelectorAll('.ap-preview-tile').length).toBe(4);
    // active theme marked
    expect(
      (el.querySelector('.themeCard[data-name="light"]') as HTMLElement).dataset.active,
    ).toBe('true');
    // active accent
    expect(el.querySelectorAll('.cd-swatch[data-active="true"]').length).toBe(1);
  });

  it('selects a theme card', () => {
    const props = makeProps();
    const el = mount(props);
    const other = THEME_PRESETS.find((p) => p.name !== 'light');
    if (!other) throw new Error('need a second preset');
    const card = el.querySelector(`.themeCard[data-name="${other.name}"]`) as HTMLButtonElement;
    act(() => card.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(props.onSetTheme).toHaveBeenCalledWith(other.name);
    expect(card.dataset.active).toBe('true');
  });

  it('picks an accent and a tile treatment', () => {
    const props = makeProps();
    const el = mount(props);
    const violet = [...el.querySelectorAll('.cd-swatch')].find(
      (b) => (b as HTMLElement).getAttribute('aria-label') === 'Violet',
    ) as HTMLButtonElement;
    act(() => violet.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(props.onSetAccent).toHaveBeenCalledWith('violet');

    const gradient = [...el.querySelectorAll('.seg button')].find(
      (b) => b.textContent === 'gradient',
    ) as HTMLButtonElement;
    act(() => gradient.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(props.onSetTile).toHaveBeenCalledWith('gradient');
  });

  it('applies match-system and cool-cast', () => {
    const props = makeProps();
    const el = mount(props);
    const matchBtn = [...el.querySelectorAll('.cd-link-btn')].find(
      (b) => b.textContent === 'Match system',
    ) as HTMLButtonElement;
    act(() => matchBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(props.onMatchSystem).toHaveBeenCalledTimes(1);

    const sw = el.querySelector('.cd-switch') as HTMLButtonElement;
    act(() => sw.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(props.onSetCoolCast).toHaveBeenCalledWith(true);
  });
});
