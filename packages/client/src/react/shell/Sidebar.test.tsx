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
    const todos = [...el.querySelectorAll('.sbItem')].find((b) =>
      b.textContent?.includes('Todos'),
    ) as HTMLButtonElement;
    act(() => todos.click());
    expect(onAppClick).toHaveBeenCalledWith('todos');
  });

  it('routes a row `•••` click through onAppContext with a rect anchor', () => {
    const onAppContext = vi.fn();
    const el = render(<Sidebar {...base} onAppContext={onAppContext} />);
    const more = el.querySelector('.rowMore') as HTMLButtonElement;
    act(() => more.click());
    expect(onAppContext).toHaveBeenCalledWith('todos', expect.objectContaining({ kind: 'rect' }));
  });

  it('groups Gateway and Backups under an Operations section', () => {
    const el = render(<Sidebar {...base} onGateway={() => {}} onBackups={() => {}} />);
    // Sentence case in the markup — chrome.module.css uppercases it, matching
    // the sibling "Apps · N" label.
    const section = [...el.querySelectorAll('.sbSection')].find((s) =>
      s.textContent?.includes('Operations'),
    );
    expect(section).toBeDefined();
    expect(section!.textContent).toContain('Operations');

    const items = [...el.querySelectorAll('.sbItem')];
    const gateway = items.find((b) => b.textContent?.includes('Gateway'))!;
    const backups = items.find((b) => b.textContent?.includes('Backups'))!;
    expect(gateway).toBeDefined();
    expect(backups).toBeDefined();
    // Both sit after the section header, and Gateway leads.
    expect(
      section!.compareDocumentPosition(gateway) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      gateway.compareDocumentPosition(backups) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('fires onBackups and highlights the Backups item on its route', () => {
    const onBackups = vi.fn();
    const el = render(<Sidebar {...base} activePage="backups" onBackups={onBackups} />);
    const backups = [...el.querySelectorAll('.sbItem')].find((b) =>
      b.textContent?.includes('Backups'),
    ) as HTMLButtonElement;
    act(() => backups.click());
    expect(onBackups).toHaveBeenCalled();
    expect(el.querySelector('[data-active="true"]')?.textContent).toContain('Backups');
  });

  it('disables Backups when no handler is provided, and keeps the Gateway pill to itself', () => {
    const el = render(<Sidebar {...base} gatewayStatus="up" onGateway={() => {}} />);
    const items = [...el.querySelectorAll('.sbItem')];
    const backups = items.find((b) => b.textContent?.includes('Backups')) as HTMLButtonElement;
    expect(backups.disabled).toBe(true);
    // The `live` pill belongs to Gateway's heartbeat — Backups must not grow
    // one. Asserted on the pill element, not the row text: "Backups" itself
    // contains the substring "up".
    expect(backups.querySelector('[data-tone]')).toBeNull();
    const gateway = items.find((b) => b.textContent?.includes('Gateway'))!;
    expect(gateway.querySelector('[data-tone="live"]')).not.toBeNull();
    expect(gateway.textContent).toContain('up');
  });

  it('disables Search when no handler is provided', () => {
    const el = render(<Sidebar {...base} />);
    const search = [...el.querySelectorAll('.sbItem')].find((b) =>
      b.textContent?.includes('Search'),
    ) as HTMLButtonElement;
    expect(search.disabled).toBe(true);
  });

  it('renders a head slot when provided', () => {
    const el = render(<Sidebar {...base} headSlot={<div data-testid="head">P</div>} />);
    expect(el.querySelector('[data-testid="head"]')).not.toBeNull();
  });

  it('renders the head slot above Build new — the profile switcher leads the column', () => {
    const el = render(<Sidebar {...base} headSlot={<div data-testid="head">P</div>} />);
    const head = el.querySelector('[data-testid="head"]')!;
    const buildNew = [...el.querySelectorAll('.sbItem')].find((b) =>
      b.textContent?.includes('Build new'),
    )!;
    // DOCUMENT_POSITION_FOLLOWING on `head` relative to `buildNew` means head
    // comes first in source order.
    expect(head.compareDocumentPosition(buildNew) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('omits the head slot entirely when none is supplied (no vault plane / not yet resolved)', () => {
    const el = render(<Sidebar {...base} />);
    expect(el.querySelector('[data-testid="head"]')).toBeNull();
  });

  it('shows the empty state when there are no apps or drafts', () => {
    const el = render(<Sidebar {...base} apps={[]} drafts={[]} />);
    expect(el.textContent).toContain('No apps yet');
    expect(el.textContent).toContain('Apps · 0');
  });

  it('shows no relaunch pill by default', () => {
    const el = render(<Sidebar {...base} />);
    expect(el.querySelector('.sbUpdate')).toBeNull();
    expect(el.textContent).not.toContain('Relaunch to update');
  });

  it('shows the relaunch pill with the new version and fires the handler', () => {
    const onRelaunchToUpdate = vi.fn();
    const el = render(
      <Sidebar {...base} updateVersion="0.2.0" onRelaunchToUpdate={onRelaunchToUpdate} />,
    );
    const pill = el.querySelector('.sbUpdate') as HTMLButtonElement;
    expect(pill.textContent).toContain('Relaunch to update');
    expect(pill.textContent).toContain('v0.2.0');
    act(() => pill.click());
    expect(onRelaunchToUpdate).toHaveBeenCalledTimes(1);
  });

  it('renders the relaunch pill above Settings, below the stretch spacer', () => {
    const el = render(<Sidebar {...base} updateVersion="0.2.0" onRelaunchToUpdate={() => {}} />);
    const pill = el.querySelector('.sbUpdate')!;
    const settings = [...el.querySelectorAll('.sbItem')].find((b) =>
      b.textContent?.includes('Settings'),
    )!;
    expect(pill.compareDocumentPosition(settings) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
