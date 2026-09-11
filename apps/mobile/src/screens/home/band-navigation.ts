// WHERE A HOME BAND TAB GOES, AS A VALUE (#1015, R-NY-1).
//
// The Home band draws on Home and on every frame place root, so a tab press
// is no longer Home's private switch. The invariant held here: selecting a
// band tab never grows the root stack past Home + one place. The root is
// RESET to Home (the same route, so Home keeps its key and its state) plus the
// target. A push from a place would stack place on place, and a member who
// switched five tabs would need five backs to reach Home. `navigate` is no fix
// either: React Navigation 7 pushes a second copy of a route already in the
// stack, which is how `lib/notifications.tsx` once stacked a second Home.
//
// Pure: it reads the root stack's routes and returns the next stack, so the
// invariant is tested without a navigator (`band-navigation.test.ts`).

import type { RootStackParamList } from "../../navigation";
import type { BandTarget } from "./band";
import type { PlaceId } from "./places";

export interface StackRoute {
  readonly key?: string;
  readonly name: string;
  readonly params?: object;
}

export interface BandStack {
  index: number;
  routes: StackRoute[];
}

const HOME: keyof RootStackParamList = "Home";

/**
 * Home's route param for "More, from a place": Home opens the all-apps sheet
 * on arrival and clears the param. It is a param on the ONE Home, not a
 * second Home carrying a sheet.
 */
export const ALL_APPS_SHEET = "all-apps";

interface PlaceRoute extends StackRoute {
  readonly name: keyof RootStackParamList;
}

/**
 * The root route each place lives on. Every id here goes somewhere: a tab
 * onto nothing is worse than a missing one (#1015 B15). `default` is `never`,
 * so a new place is a typecheck failure until it is given a route.
 */
export function placeRoute(id: Exclude<PlaceId, "home">): PlaceRoute {
  switch (id) {
    case "notifs":
      return { name: "Settings", params: { screen: "NeedsYou" } };
    case "autos":
      return { name: "Automations" };
    case "conn":
      return { name: "Connectors" };
    case "settings":
      return { name: "Settings", params: { screen: "SettingsHome" } };
    case "stats":
      return { name: "Insights" };
    case "gateway":
      return { name: "SystemOnPhone" };
    case "storage":
      return { name: "Settings", params: { screen: "PhoneStorage" } };
    case "data":
      return { name: "Data" };
    case "devices":
      return { name: "Devices" };
    default: {
      const exhaustive: never = id;
      throw new Error(`Unhandled place: ${String(exhaustive)}`);
    }
  }
}

/**
 * The root stack after a band tab press: Home alone for the Home tab, Home
 * with the all-apps sheet for More, Home + the place for a place. Home is the
 * route already in the stack when there is one (a cold deep link may have
 * none, and then a fresh Home goes underneath).
 */
export function bandStack(
  routes: readonly StackRoute[],
  target: BandTarget
): BandStack {
  const home = routes.find((route) => route.name === HOME) ?? { name: HOME };
  if (target === "home") return { index: 0, routes: [home] };
  if (target === "more")
    return {
      index: 0,
      routes: [{ ...home, params: { ...home.params, sheet: ALL_APPS_SHEET } }],
    };
  return { index: 1, routes: [home, placeRoute(target)] };
}
