// The shell's navigation history, as a pure reducer.
//
// This is a faithful port of the imperative router that lived in the vanilla
// `app.ts` (navStack / navIndex / recordRoute / goBack / goForward). Extracting
// it as a reducer lets the React shell own routing without the `applyingNav`
// re-entrancy guard — the vanilla code needed that flag because `applyRoute`
// both replayed history *and* was the only render path, so a replay would
// otherwise re-record itself. Here the action variants keep those concerns
// apart: `navigate` records, `back`/`forward` only move the cursor.
import type { ShellRoute } from '../../app-shell-context.js';

export interface RouterState {
  readonly stack: readonly ShellRoute[];
  readonly index: number;
}

export type RouterAction =
  | { type: 'navigate'; route: ShellRoute }
  | { type: 'back' }
  | { type: 'forward' };

export const INITIAL_ROUTER: RouterState = { stack: [], index: -1 };

/** Stable identity for a route — dedupes consecutive navigations to the same
 *  place, matching the vanilla `routeKey`. Two routes with the same key are the
 *  same history entry. */
export function routeKey(route: ShellRoute): string {
  switch (route.kind) {
    case 'home':
    case 'settings':
    case 'assistant':
    case 'insights':
    case 'discover':
    case 'starred':
    case 'automations':
    case 'approvals':
    case 'gateway':
    case 'templates':
      return route.kind;
    case 'automation-view':
      return `automation-view:${route.automationId}`;
    case 'run-view':
      return `run-view:${route.runId}`;
    case 'app':
      return `app:${route.id}`;
    case 'automation-builder':
      return `automation-builder:${route.automationId}`;
    case 'builder':
      return route.appContext
        ? `builder:${route.appContext.id}`
        : `builder:new:${route.initialPrompt ?? ''}`;
  }
}

export function currentRoute(state: RouterState): ShellRoute | undefined {
  return state.index >= 0 ? state.stack[state.index] : undefined;
}

export function canGoBack(state: RouterState): boolean {
  return state.index > 0;
}

export function canGoForward(state: RouterState): boolean {
  return state.index >= 0 && state.index < state.stack.length - 1;
}

export function routerReducer(state: RouterState, action: RouterAction): RouterState {
  switch (action.type) {
    case 'navigate': {
      const cur = currentRoute(state);
      // No-op a repeat of the entry we're already on (vanilla recordRoute).
      if (cur && routeKey(cur) === routeKey(action.route)) return state;
      const stack = state.stack.slice(0, state.index + 1);
      stack.push(action.route);
      return { stack, index: stack.length - 1 };
    }
    case 'back':
      return canGoBack(state) ? { ...state, index: state.index - 1 } : state;
    case 'forward':
      return canGoForward(state) ? { ...state, index: state.index + 1 } : state;
  }
}
