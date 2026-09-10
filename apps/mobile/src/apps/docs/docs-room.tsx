// THE DOCS FRAME, AS ROOM PROPS (#1015, Wave 2).
//
// `DocsScreen.tsx` used to wrap every Docs surface, and every surface drew
// `DocsShelfHeader` inside it. Both are gone: the header, the back control and
// the frame's chrome are the room's, and what is left over — the band, its
// More sheet, and the two facts true on every route — is what this hook hands
// a screen so thirteen files do not each rebuild it.
//
// The back target is READ OFF THE STACK, never passed: the thirteen call sites
// that used to name it all said "All", whatever they actually sat behind
// (audit B7). `parentPlace` over `docsRouteTitle` is that fact, as a value no
// screen can write down.

import { useNavigation, useNavigationState } from "@react-navigation/native";
import React, { useState } from "react";

import { useBandOwner } from "../../kit/band/band-owner";
import ReplicaStatusBar from "../../kit/replica/ReplicaStatusBar";
import { parentPlace, placeStack } from "../../kit/rooms/place";
import type { PlaceRef } from "../../kit/rooms/place";
import type { BandState } from "../../kit/rooms/room-contracts";
import type { DocsShellNavigation } from "../../navigation";
import VaultBar from "../../screens/home/VaultBar";
import { resolveDocsMoreRoute } from "./docs-band";
import type { DocsBandDestinationKey, DocsMoreRowKey } from "./docs-band";
import { DOCS_ROOT_TITLE, docsRouteTitle } from "./docs-places";
import DocsBand from "./DocsBand";
import DocsMoreSheet from "./DocsMoreSheet";

export interface DocsRoom {
  /** The two facts true on every route: which vault, which gateway. */
  chrome: React.JSX.Element;
  /** The app's band, told what state the room puts it in (D5). */
  band: (state: BandState) => React.JSX.Element;
  /** The More sheet, which is a presentation and belongs in `overlay`. */
  overlay: React.JSX.Element;
  /** What this route calls itself. */
  title: string;
  /** What it descends from; `undefined` on a cold start into a deep link. */
  backTo: PlaceRef | undefined;
  handleBack: () => void;
}

export function useDocsRoom(current: DocsBandDestinationKey): DocsRoom {
  const navigation = useNavigation<DocsShellNavigation>();
  const [moreOpen, setMoreOpen] = useState(false);
  // One latch per app: hand-back applies app-wide.
  const { bandOwner } = useBandOwner("docs");
  const state = useNavigationState((live) => live);
  const routes = state?.routes.slice(0, (state.index ?? 0) + 1) ?? [];
  const stack = placeStack(
    routes.map((route) => ({
      key: route.name,
      title: docsRouteTitle(route),
    }))
  );
  const here = routes[routes.length - 1];

  const onDestination = (key: DocsBandDestinationKey): void => {
    if (key === "more") {
      setMoreOpen(true);
      return;
    }
    // Band taps POP home — navigate would re-push DocsHome (RN7).
    navigation.popTo("DocsHome", { destination: key });
  };

  const onMoreRow = (key: DocsMoreRowKey): void => {
    setMoreOpen(false);
    // Coming due and Search are DocsHome DESTINATIONS, not screens
    // (docs-band.ts: why Search gave up its band slot).
    if (key === "due" || key === "search") {
      navigation.popTo("DocsHome", { destination: key });
      return;
    }
    // Literal screen name per call: navigate's tuple overloads need one.
    const screen = resolveDocsMoreRoute(key);
    switch (screen) {
      case "DocsRecent":
        navigation.navigate("DocsRecent");
        break;
      case "DocsTrash":
        navigation.navigate("DocsTrash");
        break;
      case "DocsStorage":
        navigation.navigate("DocsStorage");
        break;
      case "DocsCapabilities":
        navigation.navigate("DocsCapabilities");
        break;
      case "DocsAdd":
        navigation.navigate("DocsAdd");
        break;
      default: {
        const exhaustive: never = screen;
        throw new Error(`Unhandled More screen: ${String(exhaustive)}`);
      }
    }
  };

  return {
    backTo: parentPlace(stack),
    band: (bandState) => (
      <DocsBand
        owner={bandOwner}
        current={current}
        dimmed={bandState.dimmed}
        onSelect={bandState.interactive ? onDestination : () => undefined}
        // goBack() no-ops under a deep link; navigate re-pushes Home.
        onHome={
          bandState.interactive
            ? () => navigation.popTo("Home")
            : () => undefined
        }
      />
    ),
    chrome: (
      <>
        {/* Above the body, never inside it: frame chrome does not scroll away. */}
        <VaultBar />
        <ReplicaStatusBar />
      </>
    ),
    handleBack: () => navigation.goBack(),
    overlay: (
      <DocsMoreSheet
        visible={moreOpen}
        onClose={() => setMoreOpen(false)}
        onSelect={onMoreRow}
      />
    ),
    title: here ? docsRouteTitle(here) : DOCS_ROOT_TITLE,
  };
}
