import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HomeAppItemDTO, HomeAutoItemDTO, HomeBridgeProps } from '../screen-contracts.js';
import HomeScreen from './HomeScreen.js';

const appItems: HomeAppItemDTO[] = [
  {
    id: 'todos',
    name: 'Todos',
    desc: 'Small things',
    iconKey: 'Todo',
    tile: { background: '#000', glyphColor: '#fff' },
    tone: null,
    stamp: '2h ago',
    starred: false,
    draft: false,
  },
  {
    id: 'draft1',
    name: 'Draft App',
    desc: '',
    iconKey: 'Sparkle',
    tile: { background: '#111', glyphColor: '#fff' },
    tone: 'draft',
    stamp: 'saved',
    starred: true,
    draft: true,
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
    starred: false,
  },
];

function makeProps(over: Partial<HomeBridgeProps> = {}): HomeBridgeProps {
  return {
    builderEnabled: true,
    suggestions: ['Habit tracker', 'Weekly review'],
    dateLabel: 'TUESDAY · 19 MAY',
    appItems,
    automationItems,
    counts: { all: 3, apps: 2, automations: 1 },
    attention: 0,
    onBuild: vi.fn(),
    onOpenApp: vi.fn(),
    onEnterDraft: vi.fn(),
    onAppContext: vi.fn(),
    onOpenAutomation: vi.fn(),
    onAutomationMenu: vi.fn(),
    onBrowseTemplates: vi.fn(),
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
function mount(props: HomeBridgeProps): HTMLDivElement {
  container = document.createElement('div');
  document.body.appendChild(container);
  act(() => {
    root = createRoot(container as HTMLDivElement);
    root.render(<HomeScreen {...props} />);
  });
  return container;
}
function typeInto(input: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    globalThis.HTMLTextAreaElement.prototype,
    'value',
  )?.set;
  act(() => {
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('HomeScreen', () => {
  it('renders the composer hero, suggestions, filter, and the unified grid', () => {
    const el = mount(makeProps());
    expect(el.querySelector('.composerInput')).toBeTruthy();
    expect(el.querySelector('.composerMic')).toBeTruthy();
    expect(el.querySelectorAll('.heroSuggestions .chip').length).toBe(2);
    expect(el.querySelectorAll('.discSegB').length).toBe(3);
    // 2 apps + 1 automation card
    expect(el.querySelectorAll('.wrap').length).toBe(3);
    // draft app has a status pill + is starred flag
    expect(el.textContent).toContain('Digest');
    expect(el.querySelector('[data-kind="automation"]')).toBeTruthy();
  });

  it('builds from the composer (send enabled after typing)', () => {
    const props = makeProps();
    const el = mount(props);
    const send = el.querySelector('.composerSend') as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    typeInto(el.querySelector('.composerInput') as HTMLTextAreaElement, 'a todo app');
    expect((el.querySelector('.composerSend') as HTMLButtonElement).disabled).toBe(false);
    void act(() =>
      (el.querySelector('.composerSend') as HTMLButtonElement).dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      ),
    );
    expect(props.onBuild).toHaveBeenCalledWith('a todo app');
  });

  it('opens an app, enters a draft, and right-clicks for the context menu', () => {
    const props = makeProps();
    const el = mount(props);
    const cards = [...el.querySelectorAll('.card[data-kind="app"]')] as HTMLButtonElement[];
    void act(() => cards[0]?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(props.onOpenApp).toHaveBeenCalledWith('todos');
    void act(() => cards[1]?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(props.onEnterDraft).toHaveBeenCalledWith('draft1');
    void act(() =>
      cards[0]?.dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, clientX: 5, clientY: 6 }),
      ),
    );
    expect(props.onAppContext).toHaveBeenCalledWith('todos', { kind: 'point', x: 5, y: 6 });
  });

  it('filters to automations and toggles the layout', () => {
    const el = mount(makeProps());
    const autoTab = [...el.querySelectorAll('.discSegB')].find(
      (b) => (b as HTMLElement).dataset.k === 'automation',
    ) as HTMLButtonElement;
    void act(() => autoTab.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(el.querySelectorAll('.wrap').length).toBe(1);
    expect(el.querySelector('[data-kind="app"]')).toBeNull();
    const rowsBtn = [...el.querySelectorAll('.libLayoutBtn')].find(
      (b) => (b as HTMLElement).dataset.layout === 'rows',
    ) as HTMLButtonElement;
    void act(() => rowsBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect((el.querySelector('.appsGrid') as HTMLElement).dataset.layout).toBe('rows');
  });

  it('opens an automation + its more-menu, and browses templates', () => {
    const props = makeProps();
    const el = mount(props);
    const autoCard = el.querySelector('.card[data-kind="automation"]') as HTMLButtonElement;
    void act(() => autoCard.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(props.onOpenAutomation).toHaveBeenCalledWith('a@1');
    const autoWrap = autoCard.closest('.wrap') as HTMLElement;
    void act(() =>
      (
        autoWrap.querySelector('button[aria-label="More actions"]') as HTMLButtonElement
      ).dispatchEvent(new MouseEvent('click', { bubbles: true })),
    );
    expect(props.onAutomationMenu).toHaveBeenCalledWith(
      'a@1',
      expect.objectContaining({ kind: 'rect' }),
    );
    void act(() =>
      (el.querySelector('.hsecBrowse') as HTMLButtonElement).dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      ),
    );
    expect(props.onBrowseTemplates).toHaveBeenCalledTimes(1);
  });

  it('shows an empty state when the filtered kind has nothing', () => {
    const el = mount(
      makeProps({ appItems: [], automationItems: [], counts: { all: 0, apps: 0, automations: 0 } }),
    );
    expect(el.querySelector('.shelfEmpty')).toBeTruthy();
    expect(el.textContent).toContain('Nothing here yet');
  });

  it('hides the composer hero + suggestions when the builder is disabled (#434)', () => {
    const el = mount(makeProps({ builderEnabled: false }));
    // The build composer is the primary builder entry point — gone.
    expect(el.querySelector('.composerInput')).toBeNull();
    expect(el.querySelector('.heroSuggestions')).toBeNull();
    expect(el.textContent).not.toContain('What should we build?');
    // The library shelf (installed apps + automations) still renders.
    expect(el.querySelectorAll('.discSegB').length).toBe(3);
    expect(el.querySelectorAll('.wrap').length).toBe(3);
  });

  it('drops the "describe an app" build prompt from empty states when disabled (#434)', () => {
    const el = mount(
      makeProps({
        builderEnabled: false,
        appItems: [],
        automationItems: [],
        counts: { all: 0, apps: 0, automations: 0 },
      }),
    );
    expect(el.textContent).not.toContain('in the box above');
    expect(el.textContent).not.toContain('template gallery');
    expect(el.textContent).toContain('from Discover');
  });
});
