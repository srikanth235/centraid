// What the mobile band carries (the Binding Layer, invariant 1).
//
// The band lists the places the FRAME can go, and never the installed apps.
// Which places is no longer a hard-coded five: the handoff's compact spec
// (:3480) is "Home plus four pinned places plus More", so the band now reads
// straight off ./places — the SAME eleven-row table and pin state the
// All-apps sheet edits. Pin four different places there and the band follows,
// in the table's fixed order, exactly as the desktop stem already does for
// its own launcher (packages/client/src/react/shell/launcherModel.ts).
//
// Apps live on Home and in All apps. The band holds Home plus up to four
// pinned places, plus More — five destinations plus More, which is exactly
// invariant 1's cap, and at 390px leaves every tab well over the 44pt floor.
//
// Pure (no React, no navigation, no storage) by the same discipline as
// ./places and ./tile-model: `bandTabs` takes the member's pinned place ids as
// a plain array, so this module never touches AsyncStorage itself. ./home-pins
// is where that pin state is persisted, for both the app grid and the places
// added here.

import type { IconName } from "@centraid/design";

import { bandPlaces } from "./places";
import type { Place, PlaceId } from "./places";

/**
 * Invariant 1's hard ceiling: five destinations plus More.
 *
 * A sixth destination puts every target under 44pt on a 390px screen, so this
 * is a constraint, not a preference.
 */
export const MAX_BAND_TABS = 5;

/** Where a band tab goes: any place, or `"more"` for the All-apps sheet. Every
 *  `PlaceId` resolves to a real mobile screen (or, where this app has not
 *  built that screen yet, the nearest one that already holds those facts). */
export type BandTarget = PlaceId | "more";

export interface BandTab {
  id: PlaceId;
  /** Full name — the accessibility label and the All-apps sheet's row text. */
  name: string;
  /** Band label. Two names do not fit a 61px tab (:3480), so this is the
   *  table's own `short` field, never a truncated `name`. */
  short: string;
  icon: IconName;
}

function toTab(place: Place): BandTab {
  return {
    icon: place.icon,
    id: place.id,
    name: place.name,
    short: place.short,
  };
}

/**
 * The band's destinations, in order, from the reading edge: Home (by law),
 * then the member's pinned places in the table's fixed order, capped at
 * `MAX_BAND_TABS` total. `More` is not in this list — it is not a
 * destination, it is the overflow, and `HomeBand` renders it separately with
 * its own "···" glyph rather than an app icon (:2575-2578).
 *
 * Called with `DEFAULT_PLACE_PINS` (./places), this returns Home, Alerts,
 * Activity, Vault. More is always rendered separately. A member's next pin may
 * fill the fifth destination slot; More then becomes the sixth 44pt target.
 */
export function bandTabs(pinnedIds: readonly PlaceId[]): readonly BandTab[] {
  return bandPlaces(pinnedIds).map(toTab);
}
