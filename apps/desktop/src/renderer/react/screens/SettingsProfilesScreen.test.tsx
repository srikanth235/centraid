import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SettingsProfilesBridgeProps } from '../bridge.js';
import SettingsProfilesScreen from './SettingsProfilesScreen.js';

function makeProps(over: Partial<SettingsProfilesBridgeProps> = {}): SettingsProfilesBridgeProps {
  return {
    profiles: [
      {
        id: 'home',
        name: 'Home',
        icon: 'Home',
        color: '#3EC8B4',
        subLine: 'Local · 4 apps',
        active: true,
        primordial: true,
      },
      {
        id: 'work',
        name: 'Work',
        icon: 'Folder',
        color: '#7C5BD9',
        subLine: 'Local · 2 apps',
        active: false,
        primordial: false,
      },
    ],
    connections: [
      {
        id: 'local',
        displayName: 'This computer',
        sub: 'This computer',
        active: true,
        removable: false,
      },
      {
        id: 'remote1',
        displayName: 'Cloud',
        sub: 'https://gw.example',
        active: false,
        removable: true,
      },
    ],
    onSwitch: vi.fn(),
    onEdit: vi.fn(),
    onDelete: vi.fn(),
    onAdd: vi.fn(),
    onConnect: vi.fn(),
    onRemoveConnection: vi.fn(),
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
function mount(props: SettingsProfilesBridgeProps): HTMLDivElement {
  container = document.createElement('div');
  document.body.appendChild(container);
  act(() => {
    root = createRoot(container as HTMLDivElement);
    root.render(<SettingsProfilesScreen {...props} />);
  });
  return container;
}

const spacesRows = (el: HTMLElement): HTMLElement[] =>
  [...el.querySelector('.cd-prof-manage')!.querySelectorAll('.cd-prof-row')] as HTMLElement[];

describe('SettingsProfilesScreen', () => {
  it('renders space rows (active badge, no switch; primordial no delete) + connections', () => {
    const el = mount(makeProps());
    const rows = spacesRows(el);
    expect(rows.length).toBe(2);
    // active + primordial "Home": has badge, no switch, no delete
    expect(rows[0]?.querySelector('.cd-prof-row-badge')?.textContent).toBe('Active');
    expect(rows[0]?.querySelector('.cd-prof-row-switch')).toBeNull();
    expect(rows[0]?.querySelector('.cd-prof-row-del')).toBeNull();
    // inactive "Work": has switch + delete
    expect(rows[1]?.querySelector('.cd-prof-row-switch')).toBeTruthy();
    expect(rows[1]?.querySelector('.cd-prof-row-del')).toBeTruthy();
    // connections: 2 rows total in the second list
    expect(el.textContent).toContain('This computer');
    expect(el.textContent).toContain('Cloud');
  });

  it('fires space actions (switch, edit, delete, add)', () => {
    const props = makeProps();
    const el = mount(props);
    const workRow = spacesRows(el)[1] as HTMLElement;
    const click = (sel: string): void => {
      act(() => {
        (workRow.querySelector(sel) as HTMLButtonElement).dispatchEvent(
          new MouseEvent('click', { bubbles: true }),
        );
      });
    };
    click('.cd-prof-row-switch');
    expect(props.onSwitch).toHaveBeenCalledWith('work');
    click('.cd-icon-btn:not(.cd-prof-row-del)');
    expect(props.onEdit).toHaveBeenCalledWith('work');
    click('.cd-prof-row-del');
    expect(props.onDelete).toHaveBeenCalledWith('work');
    act(() =>
      (el.querySelector('.cd-prof-manage-add') as HTMLButtonElement).dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      ),
    );
    expect(props.onAdd).toHaveBeenCalledTimes(1);
  });

  it('fires connection connect + remove', () => {
    const props = makeProps();
    const el = mount(props);
    const connList = el.querySelectorAll('.cd-prof-manage-list')[1] as HTMLElement;
    const remoteRow = [...connList.querySelectorAll('.cd-prof-row')].find((r) =>
      r.textContent?.includes('Cloud'),
    ) as HTMLElement;
    act(() =>
      (remoteRow.querySelector('.cd-prof-row-switch') as HTMLButtonElement).dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      ),
    );
    expect(props.onConnect).toHaveBeenCalledWith('remote1');
    act(() =>
      (remoteRow.querySelector('.cd-prof-row-del') as HTMLButtonElement).dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      ),
    );
    expect(props.onRemoveConnection).toHaveBeenCalledWith('remote1');
  });
});
