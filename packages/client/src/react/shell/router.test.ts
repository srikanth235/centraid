import { describe, expect, it } from 'vitest';
import type { ShellRoute } from '../../app-shell-context.js';
import {
  canGoBack,
  canGoForward,
  currentRoute,
  INITIAL_ROUTER,
  routeKey,
  routerReducer,
  type RouterState,
} from './router.js';

const nav = (state: RouterState, route: ShellRoute) =>
  routerReducer(state, { type: 'navigate', route });

describe('shell router', () => {
  it('starts empty', () => {
    expect(currentRoute(INITIAL_ROUTER)).toBeUndefined();
    expect(canGoBack(INITIAL_ROUTER)).toBe(false);
    expect(canGoForward(INITIAL_ROUTER)).toBe(false);
  });

  it('records navigations and advances the cursor', () => {
    let s = nav(INITIAL_ROUTER, { kind: 'home' });
    s = nav(s, { kind: 'insights' });
    expect(currentRoute(s)).toEqual({ kind: 'insights' });
    expect(s.stack).toHaveLength(2);
    expect(canGoBack(s)).toBe(true);
    expect(canGoForward(s)).toBe(false);
  });

  it('dedupes a repeat of the current entry', () => {
    let s = nav(INITIAL_ROUTER, { kind: 'home' });
    const before = s;
    s = nav(s, { kind: 'home' });
    expect(s).toBe(before);
    expect(s.stack).toHaveLength(1);
  });

  it('goes back and forward without re-recording', () => {
    let s = nav(INITIAL_ROUTER, { kind: 'home' });
    s = nav(s, { kind: 'insights' });
    s = nav(s, { kind: 'discover' });
    s = routerReducer(s, { type: 'back' });
    expect(currentRoute(s)).toEqual({ kind: 'insights' });
    expect(canGoForward(s)).toBe(true);
    s = routerReducer(s, { type: 'forward' });
    expect(currentRoute(s)).toEqual({ kind: 'discover' });
  });

  it('truncates the forward branch on a new navigation', () => {
    let s = nav(INITIAL_ROUTER, { kind: 'home' });
    s = nav(s, { kind: 'insights' });
    s = routerReducer(s, { type: 'back' }); // back to home
    s = nav(s, { kind: 'discover' }); // new branch drops insights
    expect(s.stack.map((r) => r.kind)).toEqual(['home', 'discover']);
    expect(canGoForward(s)).toBe(false);
  });

  it('back/forward are no-ops at the ends', () => {
    let s = nav(INITIAL_ROUTER, { kind: 'home' });
    expect(routerReducer(s, { type: 'back' })).toBe(s);
    expect(routerReducer(s, { type: 'forward' })).toBe(s);
  });

  it('keys parameterized routes by their identity', () => {
    expect(routeKey({ kind: 'run-view', automationId: 'a', runId: 'r1' })).toBe('run-view:r1');
    expect(routeKey({ kind: 'automation-view', automationId: 'a2' })).toBe('automation-view:a2');
    expect(routeKey({ kind: 'app', id: 'todos' })).toBe('app:todos');
    expect(routeKey({ kind: 'builder' })).toBe('builder:new:');
    expect(routeKey({ kind: 'automation-builder', automationId: 'x' })).toBe(
      'automation-builder:x',
    );
    expect(routeKey({ kind: 'automation-editor' })).toBe('automation-editor:new');
    expect(routeKey({ kind: 'automation-editor', automationId: 'a2' })).toBe(
      'automation-editor:a2',
    );
    expect(routeKey({ kind: 'connectors' })).toBe('connectors');
  });

  it('treats distinct parameterized routes as separate entries', () => {
    let s = nav(INITIAL_ROUTER, { kind: 'app', id: 'todos' });
    s = nav(s, { kind: 'app', id: 'notes' });
    expect(s.stack).toHaveLength(2);
  });
});
