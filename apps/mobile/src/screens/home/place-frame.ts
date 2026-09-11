// WHERE A PLACE ROOT STANDS (#1015, R-NY-1).
//
// A place screen is a place ROOT, and draws the Home band, only when it sits
// directly on Home. The band's own reset always produces exactly Home + one
// place (`band-navigation.ts`), so anything deeper was pushed from somewhere
// else — Vault → Copies, Needs you → Activity — and is a sub-page. A sub-page
// keeps a back key to what is beneath it and draws no band.
//
// One level of nesting exists (Settings' own stack): a screen at the bottom
// of it stands where Settings' route stands in the root stack; one pushed
// inside it is a sub-page of the screen beneath it there.
//
// Pure over the navigator's state, so `usePlaceFrame` and `PlaceBand` share
// one rule and the tests hold it without a navigator.

import { shellRouteTitle } from "../shell-places";
import { placeRoute } from "./band-navigation";
import { PLACES } from "./places";

export interface FrameState {
  readonly index?: number;
  readonly routes: readonly FrameRoute[];
}

export interface FrameRoute {
  readonly key?: string;
  readonly name: string;
  readonly params?: object;
  readonly state?: FrameState;
}

export interface FrameNavigator {
  getParent: () => FrameNavigator | undefined;
  getState: () => FrameState;
}

export type Standing =
  | { readonly root: true }
  | { readonly root: false; readonly beneath: FrameRoute | undefined };

const HOME = "Home";
const SETTINGS = "Settings";

function focusedIndex(state: FrameState): number {
  return state.index ?? state.routes.length - 1;
}

/** Directly on Home — or at the bottom with no Home at all (a cold deep
 *  link), where the band's Home tab is the only way home there is. */
function standingIn(routes: readonly FrameRoute[], at: number): Standing {
  const beneath = routes[at - 1];
  if (beneath === undefined || beneath.name === HOME) return { root: true };
  return { beneath, root: false };
}

export function placeStanding(
  navigation: FrameNavigator,
  routeKey: string
): Standing {
  const state = navigation.getState();
  const found = state.routes.findIndex((route) => route.key === routeKey);
  const at = found === -1 ? focusedIndex(state) : found;
  const parent = navigation.getParent();
  if (parent === undefined) return standingIn(state.routes, at);
  if (at > 0) return { beneath: state.routes[at - 1], root: false };
  // No navigator nests deeper than Settings' stack; a deeper one would be a
  // sub-page with no parent this rule can name, never a place root.
  if (parent.getParent() !== undefined)
    return { beneath: undefined, root: false };
  const outer = parent.getState();
  return standingIn(outer.routes, focusedIndex(outer));
}

/** Root route → the place's own name, for every place that owns a root
 *  route. Settings' stack is named by the screen inside it instead. */
const ROOT_TITLES: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(
    PLACES.flatMap((entry) => {
      if (entry.id === "home") return [];
      const { name } = placeRoute(entry.id);
      return name === SETTINGS ? [] : [[name, entry.name]];
    })
  )
);

/**
 * The words on a back key to `route`, or `undefined` when no table names it
 * (an app cover): a back key pointing at a guess is worse than none.
 */
export function beneathTitle(route: FrameRoute): string | undefined {
  // A root place's own name, else a screen inside Settings' stack
  // (SettingsHome, Needs you, …) by the shell's table.
  if (route.name !== SETTINGS)
    return ROOT_TITLES[route.name] ?? shellRouteTitle(route.name);
  const inner = route.state
    ? route.state.routes[focusedIndex(route.state)]?.name
    : (route.params as { screen?: string } | undefined)?.screen;
  return shellRouteTitle(inner);
}
