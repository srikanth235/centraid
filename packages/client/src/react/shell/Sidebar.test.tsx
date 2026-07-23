import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Sidebar from './Sidebar.js';

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
  onHome: () => {},
  onSettings: () => {},
};

describe('Sidebar', () => {
  it('hides "Build new" when onNewApp is omitted (#434 builder off)', () => {
    const el = render(<Sidebar {...base} />);
    expect(el.textContent).not.toContain('Build new');
  });

  it('highlights the active page', () => {
    const el = render(<Sidebar {...base} activePage="insights" />);
    const active = el.querySelector('[data-active="true"]');
    expect(active?.textContent).toContain('Insights');
  });

  it('puts New Chat first (no separate Assistant row) and renames Chats to History', () => {
    const onNewChat = vi.fn();
    const el = render(
      <Sidebar
        {...base}
        onNewChat={onNewChat}
        conversations={[
          { id: 'c1', title: 'Thread one', timeLabel: '1h ago' },
          { id: 'c2', title: 'Thread two', timeLabel: '2h ago' },
        ]}
      />,
    );
    expect(el.textContent).toContain('New Chat');
    expect(el.textContent).toContain('History');
    expect(el.textContent).not.toContain('Assistant');
    expect(el.textContent).not.toMatch(/Chats ·/);
    const newChat = [...el.querySelectorAll('.sbItem')].find((b) =>
      b.textContent?.includes('New Chat'),
    ) as HTMLButtonElement;
    act(() => newChat.click());
    expect(onNewChat).toHaveBeenCalled();
  });

  it('places Automations and Connectors above Pages and fires onConnectors', () => {
    const onConnectors = vi.fn();
    const el = render(
      <Sidebar
        {...base}
        activePage="connectors"
        onAutomations={() => {}}
        onConnectors={onConnectors}
      />,
    );
    const items = [...el.querySelectorAll('.sbItem')];
    const automations = items.find((b) => b.textContent?.includes('Automations'))!;
    const connectors = items.find((b) => b.textContent?.includes('Connectors'))!;
    const pagesSection = [...el.querySelectorAll('.sbSection')].find((s) =>
      s.textContent?.includes('Pages'),
    )!;
    expect(automations).toBeDefined();
    expect(connectors).toBeDefined();
    expect(pagesSection).toBeDefined();
    expect(
      automations.compareDocumentPosition(connectors) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      connectors.compareDocumentPosition(pagesSection) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    act(() => (connectors as HTMLButtonElement).click());
    expect(onConnectors).toHaveBeenCalled();
    expect(el.querySelector('[data-active="true"]')?.textContent).toContain('Connectors');
  });

  it('shows Discover under Pages and omits Starred and the Apps section', () => {
    const onDiscover = vi.fn();
    const el = render(
      <Sidebar {...base} onNewApp={() => {}} onDiscover={onDiscover} activePage="discover" />,
    );
    expect(el.textContent).toContain('Discover');
    expect(el.textContent).not.toContain('Starred');
    expect(el.textContent).not.toMatch(/Apps ·/);
    expect(el.textContent).not.toContain('No apps yet');
    const discover = [...el.querySelectorAll('.sbItem')].find((b) =>
      b.textContent?.includes('Discover'),
    ) as HTMLButtonElement;
    act(() => discover.click());
    expect(onDiscover).toHaveBeenCalled();
    expect(el.querySelector('[data-active="true"]')?.textContent).toContain('Discover');
  });

  it('groups Gateway and Backups under an Operations section', () => {
    const el = render(<Sidebar {...base} onGateway={() => {}} onBackups={() => {}} />);
    // Sentence case in the markup — chrome.module.css uppercases it.
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
    const el = render(
      <Sidebar {...base} headSlot={<div data-testid="head">P</div>} onNewApp={() => {}} />,
    );
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
