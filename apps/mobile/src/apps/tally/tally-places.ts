// WHERE A TALLY ROUTE IS, DERIVED (#1015 Wave 2, audit B7).
//
// Every Tally surface used to write down two facts about itself that it was
// in no position to know: which band tab it sat under (a `current` prop, an
// Activity or a Balances spelled per file) and, through `goBack()`, an
// unnamed parent. Both are functions of the SHELF
// the route already declares, so both are computed here from the blueprint's
// own tables — a screen cannot spell either of them wrong because a screen no
// longer spells them at all.
//
// The parent of a More destination is the APP, not the shelf the member
// happened to open the sheet from: the sheet belongs to the frame, so "Back
// to Tally" is the one answer that is never a guess.

import {
  ACTIVITY,
  EXPENSE,
  FRIEND,
  GROUP,
  GROUPS,
  RECEIPT,
  SETTLE,
  WAITING,
  shelfLabel,
} from "@centraid/blueprints/apps/tally/shelves";
import type { ShelfId } from "@centraid/blueprints/apps/tally/shelves";

// The leaf, not the barrel: `place.ts` pulls in no `react-native`, so the
// route tables stay assertable without a host tree.
import { place } from "../../kit/rooms/place";
import type { PlaceRef } from "../../kit/rooms/place";
import type { TallyBandDestinationKey } from "./tally-band";

/** The four shelves that ARE band destinations; everything else is under one
 *  of them, or under More. */
const BAND_SHELF: ReadonlyMap<ShelfId, TallyBandDestinationKey> = new Map<
  ShelfId,
  TallyBandDestinationKey
>([
  [null, "balances"],
  [ACTIVITY, "activity"],
  [GROUPS, "groups"],
  [WAITING, "contrib"],
]);

/** Which band tab a shelf lights. A More surface lights none of the four, and
 *  says so with `more` — lighting one would point at a place the member is
 *  not looking at. */
const UNDER: ReadonlyMap<ShelfId, TallyBandDestinationKey> = new Map<
  ShelfId,
  TallyBandDestinationKey
>([
  [GROUP, "groups"],
  [FRIEND, "balances"],
  [EXPENSE, "activity"],
  [RECEIPT, "activity"],
  [SETTLE, "balances"],
]);

/** The band destination this shelf sits under. */
export function tallyDestinationFor(shelf: ShelfId): TallyBandDestinationKey {
  return BAND_SHELF.get(shelf) ?? UNDER.get(shelf) ?? "more";
}

/** True where the shelf IS one of the four places, rather than under one. */
export function isTallyPlace(shelf: ShelfId): boolean {
  return BAND_SHELF.has(shelf);
}

/** The app's own place — the honest parent of anything opened from More. */
const TALLY = place({ key: "Tally", title: "Tally" });

const PLACE_OF: ReadonlyMap<TallyBandDestinationKey, PlaceRef> = new Map([
  ["balances", place({ key: "TallyHome:balances", title: shelfLabel(null) })],
  [
    "activity",
    place({ key: "TallyHome:activity", title: shelfLabel(ACTIVITY) }),
  ],
  ["groups", place({ key: "TallyHome:groups", title: shelfLabel(GROUPS) })],
  ["contrib", place({ key: "TallyHome:contrib", title: shelfLabel(WAITING) })],
  ["more", TALLY],
] as const);

/**
 * What a pushed Tally surface descends FROM. A receipt descends from the
 * expense it belongs to; everything else descends from the band destination
 * it sits under, or from the app itself when it came through More.
 */
export function tallyParentPlace(shelf: ShelfId): PlaceRef {
  if (shelf === RECEIPT)
    return place({ key: "TallyExpense", title: shelfLabel(EXPENSE) });
  return PLACE_OF.get(tallyDestinationFor(shelf)) ?? TALLY;
}
