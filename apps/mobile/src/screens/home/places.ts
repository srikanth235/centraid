// The eleven places (the Binding Layer, v4 handoff — PLACES table,
// design_handoff_photos/"Centraid System - Binding Layer v4.dc.html":3424-3436).
//
// A place is a destination the FRAME can go that is not an app: Home itself,
// plus ten rooms the shell keeps — what is waiting on a decision, what runs on
// its own, what this phone is joined to, how the vault is doing, and so on.
// The Assistant is deliberately NOT one of these (:3482 — "Not a row. The
// Assistant... a pinned app, reached from the app surface, from ⌘K, and from
// New chat"), which is why it lives in the app catalog (./catalog), not here.
//
// Order is fixed and never sorted by recency (:3470 — "a launcher that
// rearranges itself stops being something you can point at from muscle
// memory"), so every reader of `PLACES` — the band, the All-apps sheet — walks
// the same array in the same order and filters it, rather than each keeping
// its own copy of the ordering.
//
// Pure (no React, no navigation, no storage), matching ./band's discipline:
// the eleven-row table and the two pure derivations below are asserted
// directly, with no renderer and no AsyncStorage mock required. Persisted pin
// STATE (the member's own toggles) lives in ./home-pins, the same module that
// already owns the app grid's pin storage — see `getPlacePins` there.

import type { IconName } from "@centraid/design";

/** One of the eleven places, in the handoff's own id spelling (:3424-3436). */
export type PlaceId =
  | "home"
  | "notifs"
  | "autos"
  | "conn"
  | "stats"
  | "data"
  | "devices"
  | "starred"
  | "gateway"
  | "storage"
  | "settings";

export interface Place {
  id: PlaceId;
  /** Full name, used in the All-apps sheet and as the accessibility label. */
  name: string;
  /** Band label. The compact band is 61px wide (:3480) — a name that does not
   *  fit there declares a shorter one instead of being ellipsised. */
  short: string;
  icon: IconName;
  /** The description line beside the row in the All-apps sheet. */
  what: string;
  /** Home only. Pinned by law, the way a browser cannot unpin its own back
   *  button (:3469) — the All-apps row shows "by law" instead of a switch. */
  law: boolean;
  /** Whether this place is pinned out of the box. Six of the ten non-Home
   *  places default to pinned (:3469); Starred, Gateway, Storage and Settings
   *  start unpinned. */
  pin: boolean;
}

/** The places, verbatim from the handoff's `PLACES` array (:3424-3436). */
export const PLACES: readonly Place[] = [
  {
    icon: "Home",
    id: "home",
    law: true,
    name: "Home",
    pin: true,
    short: "Home",
    what: "The springboard — every app with something in it",
  },
  {
    icon: "Bell",
    id: "notifs",
    law: false,
    name: "Notifications",
    pin: true,
    short: "Alerts",
    what: "Everything the vault wanted to tell you",
  },
  {
    icon: "Bolt",
    id: "autos",
    law: false,
    name: "Automations",
    pin: true,
    short: "Rules",
    what: "Rules that run on this gateway",
  },
  {
    icon: "Plug",
    id: "conn",
    law: false,
    name: "Connectors",
    pin: true,
    short: "Connectors",
    what: "What is allowed to reach outside",
  },
  {
    icon: "Activity",
    id: "stats",
    law: false,
    name: "Analytics",
    pin: true,
    short: "Analytics",
    what: "What is in the vault, counted",
  },
  {
    icon: "Folder",
    id: "data",
    law: false,
    name: "Data",
    pin: true,
    short: "Data",
    what: "Every store, and which app may read it",
  },
  {
    icon: "Monitor",
    id: "devices",
    law: false,
    name: "Devices",
    pin: true,
    short: "Devices",
    what: "The machines holding a copy",
  },
  {
    icon: "Star",
    id: "starred",
    law: false,
    name: "Starred",
    pin: false,
    short: "Starred",
    what: "Anything you marked, from any app",
  },
  {
    icon: "Cellular",
    id: "gateway",
    law: false,
    name: "Gateway",
    pin: false,
    short: "Gateway",
    what: "The machine this vault lives on",
  },
  {
    icon: "Save",
    id: "storage",
    law: false,
    name: "Storage",
    pin: false,
    short: "Storage",
    what: "Disks, backups, and what is left",
  },
  {
    icon: "Settings",
    id: "settings",
    law: false,
    name: "Settings",
    pin: false,
    short: "Settings",
    what: "The account, the themes, the keys",
  },
];

/** How many places there are — the All-apps foot reads "M of 11 places" (:5991)
 *  against this, so a table edit cannot drift silently from the copy. */
export const PLACE_COUNT = PLACES.length;

/** The place table minus Home, since Home is law rather than a pin toggle. */
const TOGGLEABLE_PLACES: readonly Place[] = PLACES.filter((p) => !p.law);

/** The pin set a member starts with: the six places whose `pin` is `true`
 *  (:3469 — "eleven places... six pinned by default"). Out of the box this
 *  keeps the compact band unchanged, because the first four of these six are
 *  exactly Notifications, Automations, Connectors and Analytics (:3480). */
export const DEFAULT_PLACE_PINS: readonly PlaceId[] = TOGGLEABLE_PLACES.filter(
  (p) => p.pin
).map((p) => p.id);

/** How many non-Home places the compact band shows: `MAX_BAND_TABS` (./band)
 *  less the one slot Home itself takes. */
export const BAND_PLACE_SLOTS = 4;

/** Look a place up by id, the way the handoff's own `PLACE(id)` helper does.
 *  The fallback can only be reached by an id outside the `PlaceId` union, so
 *  `PLACES[0]` (Home) is guaranteed present — the non-null assertion is the
 *  table's own invariant, not an unchecked guess. */
export function getPlace(id: PlaceId): Place {
  return PLACES.find((p) => p.id === id) ?? PLACES[0]!;
}

/** Whether `id` is pinned — Home always is, by law. */
export function isPlacePinned(pins: readonly PlaceId[], id: PlaceId): boolean {
  const place = getPlace(id);
  return place.law || pins.includes(id);
}

/**
 * The pinned places, Home first, in the table's fixed order — never in pin
 * order, so toggling one place on and off cannot reshuffle the rest (:3470).
 */
export function pinnedPlaces(pins: readonly PlaceId[]): readonly Place[] {
  return PLACES.filter((p) => isPlacePinned(pins, p.id));
}

/**
 * The compact band's places: Home plus the first `BAND_PLACE_SLOTS` pinned
 * places in table order (:3480). This IGNORES how many places are pinned in
 * total — a sixth pinned place still overflows to More, exactly like a sixth
 * pinned app overflows the desktop stem.
 */
export function bandPlaces(pins: readonly PlaceId[]): readonly Place[] {
  const [home, ...rest] = pinnedPlaces(pins);
  return home ? [home, ...rest.slice(0, BAND_PLACE_SLOTS)] : [];
}

/** Case-insensitive substring filter for the All-apps sheet's places section. */
export function searchPlaces(query: string): readonly Place[] {
  const q = query.trim().toLowerCase();
  if (!q) return PLACES;
  return PLACES.filter((p) => p.name.toLowerCase().includes(q));
}
