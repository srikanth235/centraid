// THE FRAME EVERY TALLY SURFACE SITS IN.
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
// `routeStatus` is asked for the ambient sentence, so the app bar carries the
// same line as the desktop's status row and neither seat can invent one.

import { useNavigation } from "@react-navigation/native";
import React, { useMemo, useState } from "react";
import { StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { routeStatus } from "@centraid/blueprints/apps/tally/route-copy";
import { shelfLabel } from "@centraid/blueprints/apps/tally/shelves";
import type { ShelfId } from "@centraid/blueprints/apps/tally/shelves";
import { ROUTE_STATUS } from "@centraid/blueprints/apps/tally/view-copy";

import { useBandOwner } from "../../kit/band/band-owner";
import AppHeader from "../../kit/components/AppHeader";
import { useTheme } from "../../kit/theme";
import { resolveAppMeta } from "../../lib/gateway";
import type { TallyShellNavigation } from "../../navigation";
import { resolveTallyMoreRoute } from "./tally-band";
import type { TallyBandDestinationKey, TallyMoreRowKey } from "./tally-band";
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
  /** Which band tab this surface belongs under. A More destination is `more`:
   *  the sheet is how the member got here, and lighting one of the other four
   *  would point at a place they are not looking at. */
  current: TallyBandDestinationKey;
  /** The shelf this route IS, for its name and its ambient sentence. */
  shelf: ShelfId;
  /** A group shared for co-contribution says which acts stay with the steward;
   *  one the member keeps alone says what sharing it would cost. Only the
   *  group ledger passes it. */
  shared?: boolean;
  /** Back to the list, or nothing where the surface IS the list. */
  onBack?: () => void;
  /** A route that is a SUBJECT rather than a place draws no band. */
  hideBand?: boolean;
  children: React.ReactNode;
}

export default function TallyScreen({
  current,
  shelf,
  shared,
  onBack,
  hideBand,
  children,
}: TallyScreenProps): React.JSX.Element {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<TallyShellNavigation>();
  const [moreOpen, setMoreOpen] = useState(false);
  const { bandOwner } = useBandOwner("tally");
  useTallySpine();
  const vault = useTallyVault();
  const denied = vault.denied;

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

  const frame = useMemo(
    () => [
      styles.frame,
      { backgroundColor: colors.bg, paddingTop: insets.top },
    ],
    [colors, insets.top]
  );

  return (
    <View style={frame}>
      <AppHeader
        title={denied ? shelfLabel(null) : shelfLabel(shelf)}
        subtitle={
          denied ? ROUTE_STATUS.denied : routeStatus(shelf, shared === true)
        }
        color={META.color}
        iconKey={META.iconKey}
        onBack={onBack ?? (() => navigation.popTo("Home"))}
      />

      <View style={styles.body}>
        {denied ? <TallyGate denied={denied} /> : children}
      </View>

      {denied || hideBand ? null : (
        <TallyBand
          owner={bandOwner}
          current={current}
          onSelect={onDestination}
          onHome={() => navigation.popTo("Home")}
        />
      )}

      <TallyMoreSheet
        visible={moreOpen && denied === null}
        onClose={() => setMoreOpen(false)}
        onSelect={onMoreRow}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  body: { flex: 1 },
  frame: { flex: 1 },
});
