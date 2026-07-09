import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Sidebar, { type SidebarApp } from './Sidebar.js';

let root: Root | null = null;
let host: HTMLElement | null = null;

function render(el: React.ReactElement): HTMLElement {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(el));
  return host;
}

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

const apps: SidebarApp[] = [
  { id: 'todos', name: 'Todos', iconKey: 'Todo', color: '#111', status: 'new' },
  { id: 'notes', name: 'Notes', iconKey: 'Sparkle', color: '#222', status: 'live' },
];
const drafts: SidebarApp[] = [
  { id: 'd1', name: 'Draft app', iconKey: 'Sparkle', color: '#333', status: 'draft' },
];

const base = {
  apps,
  drafts,
  onHome: () => {},
  onNewApp: () => {},
  onAppClick: () => {},
  onSettings: () => {},
};

describe('Sidebar', () => {
  it('renders the app list folding drafts in, with the count', () => {
    const el = render(<Sidebar {...base} />);
    expect(el.textContent).toContain('Apps · 3');
    expect(el.textContent).toContain('Todos');
    expect(el.textContent).toContain('Draft app');
  });

  it('highlights the active page', () => {
    const el = render(<Sidebar {...base} activePage="insights" />);
    const active = el.querySelector('[data-active="true"]');
    expect(active?.textContent).toContain('Insights');
  });

  it('fires onAppClick with the app id', () => {
    const onAppClick = vi.fn();
    const el = render(<Sidebar {...base} onAppClick={onAppClick} />);
    const todos = [...el.querySelectorAll('.cd-sb-item')].find((b) =>
      b.textContent?.includes('Todos'),
    ) as HTMLButtonElement;
    act(() => todos.click());
    expect(onAppClick).toHaveBeenCalledWith('todos');
  });

  it('routes a row `•••` click through onAppContext with a rect anchor', () => {
    const onAppContext = vi.fn();
    const el = render(<Sidebar {...base} onAppContext={onAppContext} />);
    const more = el.querySelector('.cd-sb-more') as HTMLButtonElement;
    act(() => more.click());
    expect(onAppContext).toHaveBeenCalledWith('todos', expect.objectContaining({ kind: 'rect' }));
  });

  it('disables Search when no handler is provided', () => {
    const el = render(<Sidebar {...base} />);
    const search = [...el.querySelectorAll('.cd-sb-item')].find((b) =>
      b.textContent?.includes('Search'),
    ) as HTMLButtonElement;
    expect(search.disabled).toBe(true);
  });

  it('renders a head slot with a divider when provided', () => {
    const el = render(<Sidebar {...base} headSlot={<div data-testid="head">P</div>} />);
    expect(el.querySelector('[data-testid="head"]')).not.toBeNull();
    expect(el.querySelector('.cd-sb-divider')).not.toBeNull();
  });

  it('shows the empty state when there are no apps or drafts', () => {
    const el = render(<Sidebar {...base} apps={[]} drafts={[]} />);
    expect(el.textContent).toContain('No apps yet');
    expect(el.textContent).toContain('Apps · 0');
  });
});
