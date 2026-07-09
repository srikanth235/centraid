import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import type { ShellRoute } from '../../app-shell-context.js';
import ShellApp, { type ShellNav } from './ShellApp.js';

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

const screenFor = (nav: ShellNav): React.ReactNode => (
  <div data-testid="screen" data-kind={nav.route.kind}>
    <button type="button" data-testid="go-insights" onClick={() => nav.navigate({ kind: 'insights' })}>
      go
    </button>
  </div>
);
const sidebarFor = (): React.ReactNode => <div data-testid="sb">SB</div>;

describe('ShellApp', () => {
  it('opens on the initial route inside the chrome frame', () => {
    const el = render(
      <ShellApp
        initialRoute={{ kind: 'home' }}
        renderSidebar={sidebarFor}
        renderScreen={screenFor}
      />,
    );
    expect(el.querySelector('.cd-window')).not.toBeNull();
    expect(el.querySelector<HTMLElement>('[data-testid="screen"]')?.dataset.kind).toBe('home');
    expect(el.querySelector('[data-testid="sb"]')).not.toBeNull();
  });

  it('navigates on dispatch and enables Back', () => {
    const el = render(
      <ShellApp
        initialRoute={{ kind: 'home' }}
        renderSidebar={sidebarFor}
        renderScreen={screenFor}
      />,
    );
    act(() => (el.querySelector('[data-testid="go-insights"]') as HTMLButtonElement).click());
    expect(el.querySelector<HTMLElement>('[data-testid="screen"]')?.dataset.kind).toBe('insights');
    const back = el.querySelector('[aria-label="Back"]') as HTMLButtonElement;
    expect(back.disabled).toBe(false);
    act(() => back.click());
    expect(el.querySelector<HTMLElement>('[data-testid="screen"]')?.dataset.kind).toBe('home');
  });

  it('bypasses the frame for full-bleed routes (app view / builder)', () => {
    const el = render(
      <ShellApp
        initialRoute={{ kind: 'app', id: 'todos' }}
        renderSidebar={sidebarFor}
        renderScreen={screenFor}
      />,
    );
    expect(el.querySelector('.cd-window')).toBeNull();
    expect(el.querySelector('[data-testid="sb"]')).toBeNull();
    expect(el.querySelector<HTMLElement>('[data-testid="screen"]')?.dataset.kind).toBe('app');
  });

  it('respects a controlled sidebarOpen prop', () => {
    let open = true;
    const el = render(
      <ShellApp
        initialRoute={{ kind: 'home' }}
        renderSidebar={sidebarFor}
        renderScreen={screenFor}
        sidebarOpen={open}
        onSidebarOpenChange={(v) => {
          open = v;
        }}
      />,
    );
    expect(el.querySelector<HTMLElement>('.cd-window')?.dataset.sidebar).toBe('open');
    const toggle = el.querySelector('.cd-tl-side [aria-label="Hide sidebar"]') as HTMLButtonElement;
    act(() => toggle.click());
    // Controlled: the parent got the new value but didn't re-render, so the DOM
    // stays until the parent flips the prop — proves ShellApp deferred to it.
    expect(open).toBe(false);
  });

  const fullBleedRoutes: ShellRoute[] = [
    { kind: 'app', id: 'x' },
    { kind: 'builder' },
    { kind: 'automation-builder', automationId: 'a' },
  ];
  it.each(fullBleedRoutes)('treats %o as full-bleed by default', (r) => {
    const el = render(
      <ShellApp initialRoute={r} renderSidebar={sidebarFor} renderScreen={screenFor} />,
    );
    expect(el.querySelector('.cd-window')).toBeNull();
  });
});
