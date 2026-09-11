// ONE BAND NAVIGATION, NOT HOME'S PRIVATE SWITCH (#1015, R-NY-1).
//
// Home and every frame place root draw the same Home band, so they select its
// tabs through this one hook. It climbs from whatever navigator the caller
// sits in (a place inside Settings' own stack) to the ROOT stack and resets
// that to `bandStack`'s answer, so a tab press can never stack place on place.

import { CommonActions } from "@react-navigation/native";
import { useCallback } from "react";

import type { BandTarget } from "./band";
import { bandStack } from "./band-navigation";
import type { StackRoute } from "./band-navigation";
import type { PlaceId } from "./places";

/** The slice of a React Navigation object this hook reads. */
export interface BandNavigator {
  dispatch: (action: ReturnType<typeof CommonActions.reset>) => void;
  getParent: () => BandNavigator | undefined;
  getState: () => { readonly routes: readonly StackRoute[] };
}

function rootOf(navigation: BandNavigator): BandNavigator {
  let root = navigation;
  for (let parent = root.getParent(); parent; parent = root.getParent())
    root = parent;
  return root;
}

export interface PlaceNavigation {
  /** Home + this place; `home` pops to Home. */
  goToPlace: (id: PlaceId) => void;
  /** A band tab: a place, Home, or More. */
  selectBandTab: (target: BandTarget) => void;
}

/**
 * `onMore` is Home's own sheet: on Home, More opens it in place. Everywhere
 * else More returns to Home with the sheet open (`ALL_APPS_SHEET`). With no
 * navigator (a screen mounted outside one) every press is a no-op.
 */
export function usePlaceNavigation(
  navigation: BandNavigator | undefined,
  onMore?: () => void
): PlaceNavigation {
  const go = useCallback(
    (target: BandTarget): void => {
      if (!navigation) return;
      const root = rootOf(navigation);
      root.dispatch(
        CommonActions.reset(bandStack(root.getState().routes, target))
      );
    },
    [navigation]
  );
  const selectBandTab = useCallback(
    (target: BandTarget): void => {
      if (target === "more" && onMore) {
        onMore();
        return;
      }
      go(target);
    },
    [go, onMore]
  );
  return { goToPlace: go, selectBandTab };
}
