// THE FRAME EVERY TALLY SURFACE SITS IN — now one of the six rooms (#1015).
//
// It owns three things no screen should own twice: the spine read, the DENIED
// GATE, and the band with its More sheet.
//
// THE GATE IS THE POINT. A refused grant is asked about once, here, and when
// it answers the children are not rendered at all — not dimmed, WITHDRAWN —
// and neither is the band. Fifteen routes therefore cannot each forget to
// check: a Tally surface that wraps itself in this frame cannot paint a ledger
// over a vault it was refused, because there is nothing behind the gate.
//
// The band, on the other hand, STAYS while the gate stands is the wrong shape
// too — a navigation spine over a refused grant advertises destinations that
// would each refuse in turn. So it is withdrawn with the children, exactly as
// Locker withdraws it behind a lock.
//
// WHAT THE ROOMS TOOK OVER. The header, the back affordance, the safe-area
// inset and the lockup's placement are `AppPlace`'s and `PushedPage`'s now,
// and so is the ONE fact a screen may not write down: which place it descends
// from. `current` is gone as a prop — the band tab and the parent are both
// derived from the shelf the route already declares (`tally-places.ts`).
// A pushed surface carries no ambient subtitle: `PlaceHeader` has no meta
// line, deliberately, and Tally comes in line rather than keeping its own.
//
// `routeStatus` is asked for the ambient sentence on the four places, so the
// app bar carries the same line as the desktop's status row and neither seat
// can invent one.

import { useNavigation } from "@react-navigation/native";
import React, { useState } from "react";

import { ADD_COMMIT } from "@centraid/blueprints/apps/tally/compose-copy";
import { routeStatus } from "@centraid/blueprints/apps/tally/route-copy";
import { shelfLabel } from "@centraid/blueprints/apps/tally/shelves";
import type { ShelfId } from "@centraid/blueprints/apps/tally/shelves";
import { ROUTE_STATUS } from "@centraid/blueprints/apps/tally/view-copy";

import { useBandOwner } from "../../kit/band/band-owner";
import { AppPlace, PushedPage } from "../../kit/rooms";
import { resolveAppMeta } from "../../lib/gateway";
import type { TallyShellNavigation } from "../../navigation";
import VaultBar from "../../screens/home/VaultBar";
import { resolveTallyMoreRoute } from "./tally-band";
import type { TallyBandDestinationKey, TallyMoreRowKey } from "./tally-band";
import {
  isTallyPlace,
  tallyDestinationFor,
  tallyParentPlace,
} from "./tally-places";
import TallyBand from "./TallyBand";
import TallyGate from "./TallyGate";
import TallyMoreSheet from "./TallyMoreSheet";
import { useTallySpine, useTallyVault } from "./useTallyVault";

const META = resolveAppMeta({
  id: "tally",
  name: "Tally",
  description: "Who owes whom, derived at read time.",
  iconKey: "Coin",
  colorKey: "indigo",
});

export interface TallyScreenProps {
  /** The shelf this route IS: its name, its ambient sentence, the band tab it
   *  lights and the place it descends from are all read off it. */
  shelf: ShelfId;
  /** A group shared for co-contribution says which acts stay with the steward;
   *  one the member keeps alone says what sharing it would cost. Only the
   *  group ledger passes it. */
  shared?: boolean;
  /** Back to the list, or nothing where the surface IS the list. */
  onBack?: () => void;
  /** A route that is a SUBJECT rather than a place draws no band. */
  hideBand?: boolean;
  /** The app's one create verb, in the bar's trailing slot (#1015 B2). Passed
   *  by the four band destinations only: Add expense was reachable from a text
   *  verb inside a group and from the day-one empty state, so a member with
   *  friends and no group could not record an expense at all. Withdrawn with
   *  everything else behind the denied gate. */
  onAddExpense?: () => void;
  children: React.ReactNode;
}

export default function TallyScreen({
  shelf,
  shared,
  onBack,
  hideBand,
  onAddExpense,
  children,
}: TallyScreenProps): React.JSX.Element {
  const navigation = useNavigation<TallyShellNavigation>();
  const [moreOpen, setMoreOpen] = useState(false);
  const { bandOwner } = useBandOwner("tally");
  useTallySpine();
  const vault = useTallyVault();
  const denied = vault.denied;
  const destination = tallyDestinationFor(shelf);

  const onDestination = (key: TallyBandDestinationKey): void => {
    if (key === "more") {
      setMoreOpen(true);
      return;
    }
    // popTo, never navigate: navigate would push a second copy of the list.
    navigation.popTo("TallyHome", { destination: key });
  };

  const onMoreRow = (key: TallyMoreRowKey): void => {
    setMoreOpen(false);
    // Literal screen name per call: navigate's tuple overloads need one.
    const screen = resolveTallyMoreRoute(key);
    switch (screen) {
      case "TallyRecurring":
        navigation.navigate("TallyRecurring");
        break;
      case "TallySpending":
        navigation.navigate("TallySpending");
        break;
      case "TallySearch":
        navigation.navigate("TallySearch");
        break;
      case "TallyTrash":
        navigation.navigate("TallyTrash");
        break;
      case "TallySurface":
        navigation.navigate("TallySurface", { surface: "export" });
        break;
      default: {
        const exhaustive: never = screen;
        throw new Error(`Unhandled More screen: ${String(exhaustive)}`);
      }
    }
  };

  const body = (
    <>
      {denied ? <TallyGate denied={denied} /> : children}
      <TallyMoreSheet
        onClose={() => setMoreOpen(false)}
        onSelect={onMoreRow}
        visible={moreOpen && denied === null}
      />
    </>
  );

  // The band is the app's, so the room only says what state it is in; Tally
  // has no selection mode, so that state is always live.
  const band =
    denied || hideBand === true
      ? undefined
      : (): React.JSX.Element => (
          <TallyBand
            destination={destination}
            onHome={() => navigation.popTo("Home")}
            onSelect={onDestination}
            owner={bandOwner}
          />
        );

  // The vault lockup on every route (see `VaultBar`): which vault, which
  // gateway, and the product's two global verbs. Inside the room's safe area,
  // above the header — which names the ROUTE, a different question.
  const lockup = <VaultBar />;
  const leave = onBack ?? ((): void => navigation.popTo("Home"));
  const action =
    denied || !onAddExpense
      ? undefined
      : { label: ADD_COMMIT, onPress: onAddExpense };

  if (isTallyPlace(shelf))
    return (
      <AppPlace
        action={action}
        app={{
          color: META.color,
          iconKey: META.iconKey,
          subtitle: denied
            ? ROUTE_STATUS.denied
            : routeStatus(shelf, shared === true),
          title: denied ? shelfLabel(null) : shelfLabel(shelf),
        }}
        band={band}
        lockup={lockup}
        onBack={leave}
      >
        {body}
      </AppPlace>
    );

  return (
    <PushedPage
      backTo={tallyParentPlace(shelf)}
      band={band}
      lockup={lockup}
      onBack={leave}
      title={denied ? shelfLabel(null) : shelfLabel(shelf)}
    >
      {body}
    </PushedPage>
  );
}
