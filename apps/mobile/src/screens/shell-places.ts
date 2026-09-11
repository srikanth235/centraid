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

// `place.ts` directly, not the rooms barrel: the barrel draws the rooms, and
// the band's frame rule (`home/place-frame.ts`) reads this table in tests that
// never load a room.
import { parentPlace, place } from "../kit/rooms/place";
import type { PlaceRef } from "../kit/rooms/place";
import { SHELL_TITLES } from "./shell-copy";

/** Route name → the words on a back control; the nouns are `shell-copy`'s. */
const ROUTE_TITLES: Readonly<Record<string, string>> = Object.freeze({
  NeedsYou: SHELL_TITLES.needsYou,
  BackupHealth: SHELL_TITLES.backupHealth,
  Home: "Home",
  PhoneStorage: SHELL_TITLES.onThisPhone,
  SettingsHome: SHELL_TITLES.settings,
  Sharing: SHELL_TITLES.sharing,
});

/** The title this table knows for a route, or `undefined`. */
export function shellRouteTitle(name: string | undefined): string | undefined {
  return name === undefined ? undefined : ROUTE_TITLES[name];
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
