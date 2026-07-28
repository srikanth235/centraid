import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SettingsLayoutBridgeProps } from '../screen-contracts.js';
import type * as CronTimezoneData from '../shell/routes/settingsCronTimezoneData.js';
import SettingsLayoutScreen from './SettingsLayoutScreen.js';

vi.mock(import('../shell/routes/settingsCronTimezoneData.js'), () => ({
  loadDefaultCronTimeZone: vi.fn<typeof CronTimezoneData.loadDefaultCronTimeZone>(async () => ''),
  saveDefaultCronTimeZone: vi.fn<typeof CronTimezoneData.saveDefaultCronTimeZone>(async () => null),
}));

function makeProps(over: Partial<SettingsLayoutBridgeProps> = {}): SettingsLayoutBridgeProps {
  return {
    density: 'regular',
    cardVariant: 'outlined',
    sidebarOpen: true,
    onSetDensity: vi.fn<SettingsLayoutBridgeProps['onSetDensity']>(),
    onSetCards: vi.fn<SettingsLayoutBridgeProps['onSetCards']>(),
    onSetSidebar: vi.fn<SettingsLayoutBridgeProps['onSetSidebar']>(),
    ...over,
  };
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;
describe('screens/SettingsLayoutScreen', () => {
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

  describe(SettingsLayoutScreen, () => {
    it('renders density (3) + cards (3) segmented + a sidebar switch, with active reflecting props', async () => {
      const el = mount(makeProps());
      // Flush the gateway default timezone load (mocked).
      await act(async () => {});
      expect(el.querySelectorAll('.seg')).toHaveLength(2);
      expect(seg(el, 0)).toHaveLength(3);
      expect(seg(el, 1)).toHaveLength(3);
      expect(seg(el, 0).find((b) => b.textContent === 'regular')?.dataset.active).toBe('true');
      expect((el.querySelector('.switch') as HTMLElement).dataset.on).toBe('true');
      expect(el.querySelector('[data-testid="settings-default-cron-timezone"]')).toBeTruthy();
    });

    it('changes density, cards, and the sidebar toggle', async () => {
      const props = makeProps();
      const el = mount(props);
      await act(async () => {});
      void act(() =>
        seg(el, 0)
          .find((b) => b.textContent === 'compact')
          ?.dispatchEvent(new MouseEvent('click', { bubbles: true })),
      );
      expect(props.onSetDensity).toHaveBeenCalledWith('compact');
      void act(() =>
        seg(el, 1)
          .find((b) => b.textContent === 'elevated')
          ?.dispatchEvent(new MouseEvent('click', { bubbles: true })),
      );
      expect(props.onSetCards).toHaveBeenCalledWith('elevated');
      void act(() =>
        (el.querySelector('.switch') as HTMLButtonElement).dispatchEvent(
          new MouseEvent('click', { bubbles: true }),
        ),
      );
      expect(props.onSetSidebar).toHaveBeenCalledWith(false);
    });
  });
});
