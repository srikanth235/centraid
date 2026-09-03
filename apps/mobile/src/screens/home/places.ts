import { DESTINATION_MARKS } from "@centraid/design";
import type { IconName } from "@centraid/design";

import type { MobileGatewayFeatures } from "../../lib/replica/mobile-gateway-compatibility-core";

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
  name: string;
  short: string;
  icon: IconName;
  what: string;
  law: boolean;
  pin: boolean;
}

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

export const PLACE_COUNT = PLACES.length;

const TOGGLEABLE_PLACES: readonly Place[] = PLACES.filter((p) => !p.law);

export const DEFAULT_PLACE_PINS: readonly PlaceId[] = TOGGLEABLE_PLACES.filter(
  (p) => p.pin
).map((p) => p.id);

export const BAND_PLACE_SLOTS = 4;

export function getPlace(id: PlaceId): Place {
  return PLACES.find((p) => p.id === id) ?? PLACES[0]!;
}

export function isPlacePinned(pins: readonly PlaceId[], id: PlaceId): boolean {
  const place = getPlace(id);
  return place.law || pins.includes(id);
}

export function pinnedPlaces(pins: readonly PlaceId[]): readonly Place[] {
  return PLACES.filter((p) => isPlacePinned(pins, p.id));
}

export function bandPlaces(pins: readonly PlaceId[]): readonly Place[] {
  const [home, ...rest] = pinnedPlaces(pins);
  return home ? [home, ...rest.slice(0, BAND_PLACE_SLOTS)] : [];
}

const PLACE_CAPABILITY: Partial<Record<PlaceId, keyof MobileGatewayFeatures>> =
  {
    autos: "automations",
    conn: "connectors",
  };

export function isPlaceEnabled(
  id: PlaceId,
  features: MobileGatewayFeatures | undefined
): boolean {
  const capability = PLACE_CAPABILITY[id];
  if (!capability || !features) return true;
  return features[capability];
}

export function enabledPlaces(
  features: MobileGatewayFeatures | undefined
): readonly Place[] {
  return PLACES.filter(
    (p) => p.id !== "gateway" && isPlaceEnabled(p.id, features)
  );
}

export function enabledPlacePins(
  pins: readonly PlaceId[],
  features: MobileGatewayFeatures | undefined
): readonly PlaceId[] {
  return pins.filter((id) => id !== "gateway" && isPlaceEnabled(id, features));
}

export function searchPlaces(query: string): readonly Place[] {
  const q = query.trim().toLowerCase();
  if (!q) return PLACES;
  return PLACES.filter((p) => p.name.toLowerCase().includes(q));
}
