// THE HOME BAND ON A PLACE (#1015, R-NY-1).
//
// `<PlaceBand place="stats" />` is the Home band a place root draws at its
// foot: the same `HomeBand` Home draws, with this place's tab active when it
// is pinned. A tab press goes through `usePlaceNavigation`, so switching tabs
// never grows the stack past Home + one place; pressing the tab already
// active does nothing. Screens get it through `usePlaceFrame`, which also
// hands a sub-page its back key.
//
// ONLY ON A PLACE ROOT. The node applies `placeStanding` itself, so a band
// handed to a sub-page (Vault → Copies, Settings → On this phone) draws
// nothing. It reads the navigator from context rather than `useNavigation()`,
// which throws outside a navigator, and a screen mounted outside one has
// nowhere for a band to go, so it draws nothing.

import {
  NavigationContext,
  NavigationRouteContext,
} from "@react-navigation/native";
import React, { useCallback, useContext } from "react";

import type { BandTarget } from "./band";
import HomeBand from "./HomeBand";
import { placeStanding } from "./place-frame";
import type { PlaceId } from "./places";
import { usePlaceNavigation } from "./usePlaceNavigation";

export interface PlaceBandProps {
  place: PlaceId;
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
  if (!navigation || !route || !placeStanding(navigation, route.key).root)
    return null;
  return <HomeBand active={place} onSelect={onSelect} />;
}
