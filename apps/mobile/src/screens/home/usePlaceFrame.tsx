// A PLACE'S FRAME CHROME, DECIDED ONCE (#1015, R-NY-1).
//
// Every place root screen spreads this into its `SystemPlace`. Standing on
// Home, it is the Home band (and no Home key). Pushed from anywhere else, it
// is a back key naming what is beneath, computed from the live stack the way
// `useShellParent` computes it, and no band. When nothing beneath has a name
// this app can say (an app cover), it is the grid key rather than a back key
// naming a guess. Outside a navigator it is nothing.

import {
  NavigationContext,
  NavigationRouteContext,
} from "@react-navigation/native";
import React, { useContext } from "react";

import { place } from "../../kit/rooms/place";
import type { PlaceRef } from "../../kit/rooms/place";
import { beneathTitle, placeStanding } from "./place-frame";
import PlaceBand from "./PlaceBand";
import type { PlaceId } from "./places";

export interface PlaceFrame {
  band?: React.ReactNode;
  backTo?: PlaceRef;
  onBack?: () => void;
  onHome?: () => void;
}

export function usePlaceFrame(id: PlaceId): PlaceFrame {
  const navigation = useContext(NavigationContext);
  const route = useContext(NavigationRouteContext);
  if (!navigation || !route) return {};
  const standing = placeStanding(navigation, route.key);
  if (standing.root) return { band: <PlaceBand place={id} /> };
  const { beneath } = standing;
  const title = beneath ? beneathTitle(beneath) : undefined;
  const back = (): void => navigation.goBack();
  if (beneath && title !== undefined)
    return { backTo: place({ key: beneath.name, title }), onBack: back };
  // Nothing beneath with a name (Settings opened from an app's chrome): the
  // grid key, which still goes BACK — `goBack` bubbles out of Settings' own
  // stack to the cover beneath it — rather than dropping the member on Home.
  return { onHome: back };
}
