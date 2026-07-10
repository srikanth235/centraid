import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ShellFrame from './ShellFrame.js';

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

const base = {
  sidebarOpen: true,
  onToggleSidebar: () => {},
  sidebar: <div data-testid="sb">SB</div>,
  children: <div data-testid="main">MAIN</div>,
};

describe('ShellFrame', () => {
  it('renders the window grid with sidebar + main content', () => {
    const el = render(<ShellFrame {...base} />);
    expect(el.querySelector<HTMLElement>('.window')?.dataset.sidebar).toBe('open');
    expect(el.querySelector('[data-testid="sb"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="main"]')).not.toBeNull();
    expect(el.querySelector<HTMLElement>('.tlMain')?.dataset.layout).toBe('flat');
  });

  it('marks the grid closed and shows the collapsed sidebar toggle in tlMain', () => {
    const el = render(<ShellFrame {...base} sidebarOpen={false} />);
    expect(el.querySelector<HTMLElement>('.window')?.dataset.sidebar).toBe('closed');
    // When collapsed the tlMain nav gains an extra sidebar toggle (open state
    // only carries the one in tlSide).
    const tlMain = el.querySelector('.tlMain')!;
    expect(tlMain.querySelector('[aria-label="Show sidebar"]')).not.toBeNull();
  });

  it('disables back/forward when the callbacks say so', () => {
    const el = render(<ShellFrame {...base} canGoBack={false} canGoForward />);
    const back = el.querySelector('[aria-label="Back"]') as HTMLButtonElement;
    const fwd = el.querySelector('[aria-label="Forward"]') as HTMLButtonElement;
    expect(back.disabled).toBe(true);
    expect(fwd.disabled).toBe(false);
  });

  it('fires nav callbacks', () => {
    const onBack = vi.fn();
    const onToggleSidebar = vi.fn();
    const el = render(
      <ShellFrame {...base} canGoBack onBack={onBack} onToggleSidebar={onToggleSidebar} />,
    );
    act(() => (el.querySelector('[aria-label="Back"]') as HTMLButtonElement).click());
    act(() => (el.querySelector('.tlSide [aria-label="Hide sidebar"]') as HTMLButtonElement).click());
    expect(onBack).toHaveBeenCalled();
    expect(onToggleSidebar).toHaveBeenCalled();
  });

  it('shows the New app pencil only when collapsed + showNewChat', () => {
    const open = render(<ShellFrame {...base} showNewChat />);
    expect(open.querySelector('[aria-label="New app"]')).toBeNull();
    act(() => root?.unmount());
    host?.remove();
    const closed = render(<ShellFrame {...base} sidebarOpen={false} showNewChat />);
    expect(closed.querySelector('[aria-label="New app"]')).not.toBeNull();
  });

  it('uses the grid layout with a center cluster', () => {
    const el = render(<ShellFrame {...base} titlebarCenter={<div data-testid="center">C</div>} />);
    expect(el.querySelector<HTMLElement>('.tlMain')?.dataset.layout).toBe('grid');
    expect(el.querySelector('.tlNav')).not.toBeNull();
    expect(el.querySelector('.tlContext [data-testid="center"]')).not.toBeNull();
  });
});
