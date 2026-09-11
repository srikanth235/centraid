// THE HOME BAND ON A PLACE (#1015, R-NY-1).
//
// `<PlaceBand place="stats" />` is the node a frame place root hands
// `SystemPlace`'s `band` slot: the same `HomeBand` Home draws, with this
// place's tab active when it is pinned. A tab press goes through
// `usePlaceNavigation`, so switching tabs never grows the stack past Home +
// one place; pressing the tab already active does nothing.
//
// A SUB-PAGE DRAWS NOTHING. A screen pushed inside a place's own stack
// (Settings → On this phone) keeps its back key and gets no band, so the node
// decides for itself: it reads the screen's navigator from context rather
// than `useNavigation()`, which throws outside a navigator, and a screen
// mounted outside one has nowhere for a band to go, so it draws nothing.

import {
  NavigationContext,
  NavigationRouteContext,
} from "@react-navigation/native";
import React, { useCallback, useContext } from "react";

import type { BandTarget } from "./band";
import HomeBand from "./HomeBand";
import type { PlaceId } from "./places";
import { usePlaceNavigation } from "./usePlaceNavigation";
import type { BandNavigator } from "./usePlaceNavigation";

export interface PlaceBandProps {
  place: PlaceId;
}

/**
 * A screen in the ROOT stack is always a place root. A screen in a nested
 * stack is one only at the bottom of that stack: Needs you reached from the
 * band sits alone in Settings' stack, Needs you pushed from Settings does not.
 */
export function isPushedSubPage(
  navigation: Pick<BandNavigator, "getParent"> & {
    getState: () => {
      readonly routes: readonly { readonly key?: string }[];
    };
  },
  routeKey: string
): boolean {
  if (navigation.getParent() === undefined) return false;
  return navigation.getState().routes[0]?.key !== routeKey;
}

export default function PlaceBand({
  place,
}: PlaceBandProps): React.JSX.Element | null {
  const navigation = useContext(NavigationContext);
  const route = useContext(NavigationRouteContext);
  const { selectBandTab } = usePlaceNavigation(navigation);
  const onSelect = useCallback(
    (target: BandTarget): void => {
      if (target !== place) selectBandTab(target);
    },
    [place, selectBandTab]
  );
  if (!navigation || !route || isPushedSubPage(navigation, route.key))
    return null;
  return <HomeBand active={place} onSelect={onSelect} />;
}
