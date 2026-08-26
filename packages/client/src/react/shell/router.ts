// The shell's navigation history, as a pure reducer.
//
// The action variants keep recording and replay apart: `navigate` records,
// `back`/`forward` only move the cursor. Do not collapse them into one
// "apply route" action — a single render-and-record path replays history into
// itself and needs a re-entrancy guard to stay correct.
import type { ShellRoute } from "../../app-shell-context.js";

export interface RouterState {
  readonly stack: readonly ShellRoute[];
  readonly index: number;
}

export type RouterAction =
  | { type: "navigate"; route: ShellRoute }
  // Swaps the current history entry in place (no new stack entry) — used
  // when a route's identity is resolved lazily after first paint, e.g. the
  // assistant route creating its conversation id on first send.
  | { type: "replace"; route: ShellRoute }
  | { type: "back" }
  | { type: "forward" };

export const INITIAL_ROUTER: RouterState = { stack: [], index: -1 };

/** Stable identity for a route — dedupes consecutive navigations to the same
 *  place. Two routes with the same key are the same history entry. */
export function routeKey(route: ShellRoute): string {
  switch (route.kind) {
    case "settings":
      return route.page ? `settings:${route.page}` : "settings";
    case "assistant":
      return route.conversationId
        ? `assistant:${route.conversationId}`
        : "assistant";
    case "home":
    case "insights":
    case "starred":
    case "automations":
    case "connectors":
    case "approvals":
    case "household":
    case "storage":
    case "atlas":
    case "templates":
      return route.kind;
    case "gateway":
      return ["gateway", route.tab, route.focus, route.cause]
        .filter(Boolean)
        .join(":");
    case "automation-editor":
      return `automation-editor:${route.automationId ?? "new"}`;
    case "automation-view":
      return `automation-view:${route.automationId}`;
    case "run-view":
      return `run-view:${route.runId}`;
    case "app":
      return `app:${route.id}`;
    case "automation-builder":
      return `automation-builder:${route.automationId}`;
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

export function routerReducer(
  state: RouterState,
  action: RouterAction
): RouterState {
  switch (action.type) {
    case "navigate": {
      const cur = currentRoute(state);
      // No-op a repeat of the entry we're already on.
      if (cur && routeKey(cur) === routeKey(action.route)) return state;
      const stack = state.stack.slice(0, state.index + 1);
      stack.push(action.route);
      return { stack, index: stack.length - 1 };
    }
    case "replace": {
      if (state.index < 0)
        return routerReducer(state, { type: "navigate", route: action.route });
      const stack = state.stack.slice();
      stack[state.index] = action.route;
      return { ...state, stack };
    }
    case "back":
      return canGoBack(state) ? { ...state, index: state.index - 1 } : state;
    case "forward":
      return canGoForward(state) ? { ...state, index: state.index + 1 } : state;
  }
}
