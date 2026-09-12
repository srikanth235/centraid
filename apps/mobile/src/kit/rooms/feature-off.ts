// A PLACE THIS GATEWAY HAS NOT SWITCHED ON (#1015, Wave 2).
//
// Reached only the ways a hidden place still can be: a deep link, a saved
// shortcut, a row on another screen that names it. The band and the All-apps
// sheet already drop it (`screens/home/places.ts`), so this is the wall behind
// the door rather than the door itself — and it is a wall, not a spinner and
// not a 404 from a route the gateway never mounted, because "off" is a fact
// the handshake already told us.
//
// It used to be `kit/components/FeatureOffPlace`, which drew a whole place
// frame of its own — a second header, a second leave key and a second gutter
// beside the ones every place already has. It is a ROOM STATE, so it is a
// `RoomEmpty`: the screen keeps its `SystemPlace`, its title and its leave
// key, and the body says what is closed.

import { MOBILE_FEATURE_OFF_COPY } from "../../lib/replica/mobile-gateway-compatibility-core";
import type { MobileGatewayFeatures } from "../../lib/replica/mobile-gateway-compatibility-core";
import type { RoomEmpty } from "./room-contracts";

/** The wall's words, from the compatibility core — never a copy of its own. */
export function featureOffEmpty(
  feature: keyof MobileGatewayFeatures
): RoomEmpty {
  const copy = MOBILE_FEATURE_OFF_COPY[feature];
  // Not `routine`: a gate the member cannot open is a state to explain, not
  // an empty list to fill.
  return { body: copy.body, title: copy.title };
}
