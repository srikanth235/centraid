import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HomeAppItemDTO, HomeAutoItemDTO } from '../screen-contracts.js';
import StarredScreen, { type StarredScreenProps } from './StarredScreen.js';

const appItems: HomeAppItemDTO[] = [
  {
    id: 'todos',
    name: 'Todos',
    desc: 'Small things',
    iconKey: 'Todo',
    tile: { background: '#000', glyphColor: '#fff' },
    tone: null,
    stamp: '2h ago',
    starred: true,
    draft: false,
  },
];
const automationItems: HomeAutoItemDTO[] = [
  {
    ref: 'a@1',
    name: 'Digest',
    blurb: 'Summarize inbox',
    glyphIcon: 'Bolt',
    hue: 'indigo',
    statusKind: 'active',
    statusLabel: 'Active',
    triggerIcon: 'Clock',
    triggerLabel: 'Daily',
    integrations: ['Gmail'],
    footTimeLabel: '2h ago',
    footOk: true,
    starred: true,
  },
];

function makeProps(over: Partial<StarredScreenProps> = {}): StarredScreenProps {
  return {
    appItems,
    automationItems,
    onOpenApp: vi.fn(),
    onEnterDraft: vi.fn(),
    onAppContext: vi.fn(),
    onOpenAutomation: vi.fn(),
    onAutomationMenu: vi.fn(),
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
function mount(props: StarredScreenProps): HTMLDivElement {
  container = document.createElement('div');
  document.body.appendChild(container);
  act(() => {
    root = createRoot(container as HTMLDivElement);
    root.render(<StarredScreen {...props} />);
  });
  return container as HTMLDivElement;
}

describe('StarredScreen', () => {
  it('renders starred app + automation cards with their star flags', () => {
    const el = mount(makeProps());
    expect(el.textContent).toContain('Todos');
    expect(el.textContent).toContain('Digest');
    expect(el.querySelectorAll('[data-starred="true"]').length).toBe(2);
  });

  it('opens an app on tile click', () => {
    const props = makeProps();
    const el = mount(props);
    const tile = el.querySelector<HTMLButtonElement>('[data-testid="app-tile"]');
    act(() => tile?.click());
    expect(props.onOpenApp).toHaveBeenCalledWith('todos');
  });

  it('opens an automation on its card click', () => {
    const props = makeProps();
    const el = mount(props);
    const card = el.querySelector<HTMLButtonElement>('[data-kind="automation"]');
    act(() => card?.click());
    expect(props.onOpenAutomation).toHaveBeenCalledWith('a@1');
  });
});
