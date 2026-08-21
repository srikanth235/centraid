// The eleven stable mobile place ids, presented with the v10 destination names.
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

import { DESTINATION_MARKS } from "@centraid/design";
import type { IconName } from "@centraid/design";

import type { MobileGatewayFeatures } from "../../lib/replica/mobile-gateway-compatibility-core";

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
  /** Whether this place is pinned out of the box. */
  pin: boolean;
}

/* Marks come from `DESTINATION_MARKS` (`packages/design/src/destinations.ts`),
   never a literal here. The shell keeps its OWN destination list, under
   different ids — `stats`/`insights`, `data`/`atlas`, `devices`/`household` —
   because each side's id is load-bearing for its own router and its own stored
   pins. The glyph is the one fact both lists must agree on, so it is the one
   fact neither list owns. */
/** The places, verbatim from the handoff's `PLACES` array (:3424-3436). */
export const PLACES: readonly Place[] = [
  {
    icon: DESTINATION_MARKS.home,
    id: "home",
    law: true,
    name: "Home",
    pin: true,
    short: "Home",
    what: "The springboard — every app with something in it",
  },
  {
    icon: DESTINATION_MARKS.notifications,
    id: "notifs",
    law: false,
    name: "Notifications",
    pin: true,
    short: "Alerts",
    what: "Everything the vault wanted to tell you",
  },
  {
    icon: DESTINATION_MARKS.analytics,
    id: "stats",
    law: false,
    name: "Activity",
    pin: true,
    short: "Activity",
    what: "Runs, failures, harnesses, models and spend",
  },
  {
    icon: DESTINATION_MARKS.data,
    id: "data",
    law: false,
    name: "Vault",
    pin: true,
    short: "Vault",
    what: "Contents, copies and sharing",
  },
  {
    icon: DESTINATION_MARKS.automations,
    id: "autos",
    law: false,
    name: "Automations",
    pin: false,
    short: "Rules",
    what: "Rules that run on your vault's home machine",
  },
  {
    icon: DESTINATION_MARKS.connectors,
    id: "conn",
    law: false,
    name: "Connectors",
    pin: false,
    short: "Connectors",
    what: "What is allowed to reach outside",
  },
  {
    icon: DESTINATION_MARKS.devices,
    id: "devices",
    law: false,
    name: "Copies",
    pin: false,
    short: "Copies",
    what: "The machines holding a copy",
  },
  {
    icon: DESTINATION_MARKS.starred,
    id: "starred",
    law: false,
    name: "Starred",
    pin: false,
    short: "Starred",
    what: "Anything you marked, from any app",
  },
  {
    icon: DESTINATION_MARKS.gateway,
    id: "gateway",
    law: false,
    name: "System",
    pin: false,
    short: "System",
    what: "The machine this vault lives on",
  },
  {
    icon: DESTINATION_MARKS.storage,
    id: "storage",
    law: false,
    name: "On this phone",
    pin: false,
    short: "On phone",
    what: "Cached data, pending uploads and room",
  },
  {
    icon: DESTINATION_MARKS.settings,
    id: "settings",
    law: false,
    name: "Settings",
    pin: false,
    short: "Settings",
    what: "The account, the themes, the keys",
  },
];

/** How many places the table holds — the All-apps foot reads "M of N places"
 *  (:5991) against `enabledPlaces` rather than this, so a gateway with a v0
 *  feature gate on counts the list it is actually showing; this stays the
 *  table's own size, so a table edit cannot drift silently from the copy. */
export const PLACE_COUNT = PLACES.length;

/** The place table minus Home, since Home is law rather than a pin toggle. */
const TOGGLEABLE_PLACES: readonly Place[] = PLACES.filter((p) => !p.law);

/** The v10 default: Home is law; Alerts, Activity and Vault are pinned. The
 * fifth destination slot remains available when the member pins another. */
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

/* WHICH PLACES THIS GATEWAY ACTUALLY HAS (v0 experimental gates).
 *
 * Two of the eleven are surfaces the gateway may not be serving at all:
 * Automations and Connectors are off by default in v0, and a gateway with
 * them off does not mount their routes. A band tab that opens a dead route is
 * worse than a missing one, so the table stays fixed (order is muscle memory)
 * and the two derivations below FILTER it — the same shape the pin filters
 * already use.
 *
 * The capability answer comes from the one `/info` read the compatibility
 * wall already made (`kit/replica/ReplicaProvider`'s `features`), never from
 * a probe of this module's own. `undefined` is UNKNOWN — no gateway has
 * answered yet this launch — and unknown NEVER hides a place: the same rule
 * the wall follows offline (an unanswered question is not a verdict), which
 * also keeps the band from reshuffling on every offline cold start. */
const PLACE_CAPABILITY: Partial<Record<PlaceId, keyof MobileGatewayFeatures>> =
  {
    autos: "automations",
    conn: "connectors",
  };

/** Whether `id` is a place this gateway serves. Ungated places are always. */
export function isPlaceEnabled(
  id: PlaceId,
  features: MobileGatewayFeatures | undefined
): boolean {
  const capability = PLACE_CAPABILITY[id];
  if (!capability || !features) return true;
  return features[capability];
}

/** The places this gateway serves, in the table's fixed order. */
export function enabledPlaces(
  features: MobileGatewayFeatures | undefined
): readonly Place[] {
  // Mobile is the Origin seat. System is a custodian/viewer presentation and
  // is omitted here, but its stable route id still resolves in `Home.tsx` so a
  // saved/deep link never dead-ends.
  return PLACES.filter(
    (p) => p.id !== "gateway" && isPlaceEnabled(p.id, features)
  );
}

/**
 * A member's pins minus the places this gateway does not serve — what the
 * band and the All-apps sheet read instead of the raw pin list. Dropping a
 * gated pin rather than blanking its slot lets the next pinned place take it,
 * so the band stays five wide instead of showing a hole.
 *
 * The pin STATE is untouched: switching a feature back on restores the place
 * to exactly where the member had it, the same way turning a feature off on
 * the gateway leaves its durable data intact.
 */
export function enabledPlacePins(
  pins: readonly PlaceId[],
  features: MobileGatewayFeatures | undefined
): readonly PlaceId[] {
  return pins.filter((id) => id !== "gateway" && isPlaceEnabled(id, features));
}

/** Case-insensitive substring filter for the All-apps sheet's places section. */
export function searchPlaces(query: string): readonly Place[] {
  const q = query.trim().toLowerCase();
  if (!q) return PLACES;
  return PLACES.filter((p) => p.name.toLowerCase().includes(q));
}
