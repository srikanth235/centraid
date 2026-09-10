// WHERE THE SHELL IS, AS A VALUE (#1015, Wave 2 — audit B7).
//
// `SystemPlace`/`PushedPage` take `backTo` as a `PlaceRef`, which no screen can
// write down: thirteen Docs screens named the same shelf as their parent and
// twelve of them were lying, in the visible label and the spoken one alike. So the parent is READ
// off the navigator, exactly as `DocsShelfHeader` reads it, and turned into a
// place here.
//
// The titles live in one table because a route name is not a member-facing
// word ("SettingsHome" is not "Settings"). A route this table does not know
// yields NO place, and a room with no place draws no back control — the honest
// answer, rather than a guess spoken aloud.

import { useNavigationState } from "@react-navigation/native";

import { parentPlace, place } from "../kit/rooms";
import type { PlaceRef } from "../kit/rooms";

/** Route name → the words on a back control. Sentence case (D2). */
const SHELL_TITLES: Readonly<Record<string, string>> = Object.freeze({
  Approvals: "Notifications",
  BackupHealth: "Backup health",
  PhoneStorage: "On this phone",
  SettingsHome: "Settings",
  Sharing: "Sharing",
});

/** The title this table knows for a route, or `undefined`. */
export function shellRouteTitle(name: string | undefined): string | undefined {
  return name === undefined ? undefined : SHELL_TITLES[name];
}

/**
 * The place this screen descends FROM, read off the live stack. `undefined` at
 * a stack root, and on any route the table does not name.
 */
export function useShellParent(): PlaceRef | undefined {
  return useNavigationState((state) => {
    if (!state) return undefined;
    // The entry UNDER the top, not the nearest one this table happens to
    // know: skipping an unnamed route would name a grandparent as the parent.
    const under = parentPlace(
      state.routes
        .slice(0, state.index + 1)
        .map((route) => place({ key: route.name, title: route.name }))
    );
    const title = shellRouteTitle(under?.key);
    return under && title !== undefined
      ? place({ key: under.key, title })
      : undefined;
  });
}
