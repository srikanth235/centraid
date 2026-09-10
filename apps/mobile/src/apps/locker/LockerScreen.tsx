// THE FRAME EVERY LOCKER SURFACE SITS IN.
//
// It owns four things no screen should own twice: the boundary's mount
// effects, the WALL, the band, and the switcher mask.
//
// THE WALL IS THE POINT. `shelves.suppressesNavigation` is asked once, here,
// and when it answers true the children are not rendered at all — not dimmed,
// not disabled, WITHDRAWN — and neither is the band. Ten routes therefore
// cannot each forget to check: a Locker surface that wraps itself in this
// frame cannot be reached behind a lock, because there is nothing behind it.
//
// WHAT THE ROOMS TOOK OVER (#1015). The header, the back affordance, the
// safe-area inset and the lockup's placement are `AppPlace`'s and
// `PushedPage`'s, and so is the one fact a screen may not write down: which
// place it descends from. `current` is gone as a prop — the band tab and the
// parent are both derived from the route (`locker-places.ts`). A pushed
// surface carries no ambient subtitle: `PlaceHeader` has no meta line.
//
// `gatedShelf` decides WHICH wall: a vault with no passphrase is at setup,
// full stop, whatever route the member last asked for.

import { useNavigation } from "@react-navigation/native";
import React, { useState } from "react";
import { StyleSheet, View } from "react-native";

import { suppressesNavigation } from "@centraid/blueprints/apps/locker/shelves";
import {
  ROUTE_STATUS,
  ROUTE_TITLE,
} from "@centraid/blueprints/apps/locker/view-copy";

import { useBandOwner } from "../../kit/band/band-owner";
import { useConfirmDestructive } from "../../kit/components/ConfirmSheet";
import { Text } from "../../kit/components/NativeText";
import { postStatus } from "../../kit/components/status-line";
import { AppPlace, PushedPage } from "../../kit/rooms";
import { t, useTheme } from "../../kit/theme";
import { resolveAppMeta } from "../../lib/gateway";
import type { LockerShellNavigation } from "../../navigation";
import VaultBar from "../../screens/home/VaultBar";
import { resolveLockerMoreRoute } from "./locker-band";
import type { LockerBandDestinationKey, LockerMoreRowKey } from "./locker-band";
import {
  isLockerPlace,
  lockerDestinationFor,
  lockerParentPlace,
} from "./locker-places";
import type { LockerRouteKey } from "./locker-places";
import {
  DEVICE_FORGET,
  DEVICE_FORGET_BODY,
  DEVICE_FORGET_DONE,
  DEVICE_FORGET_NOUN,
  MASKED_LABEL,
} from "./locker-seat-copy";
import {
  noteLockerActivity,
  forgetLockerVaultKey,
  unlockLocker,
} from "./locker-store";
import LockerBand from "./LockerBand";
import LockerMoreSheet from "./LockerMoreSheet";
import LockerWall from "./LockerWall";
import { useLockerBoundary, useLockerVault } from "./useLockerVault";

const META = resolveAppMeta({
  id: "locker",
  name: "Locker",
  description: "Items, revealed one at a time and receipted.",
  iconKey: "Key",
  colorKey: "rose",
});

/** Which route's word and ambient sentence the app bar carries. The keys are
 *  `ROUTE_TITLE`'s own, so a route cannot invent a name for itself. */
export type { LockerRouteKey } from "./locker-places";

export interface LockerScreenProps {
  /** The route this surface IS: its word, its ambient sentence, the band tab
   *  it lights and the place it descends from are all read off it. */
  route: LockerRouteKey;
  /** Back to the list, or nothing where the surface IS the list. */
  onBack?: () => void;
  /** The Viewer never draws the band — nor does a route that is a subject
   *  rather than a place. */
  hideBand?: boolean;
  children: React.ReactNode;
}

export default function LockerScreen({
  route,
  onBack,
  hideBand,
  children,
}: LockerScreenProps): React.JSX.Element {
  const { colors } = useTheme();
  const navigation = useNavigation<LockerShellNavigation>();
  const [moreOpen, setMoreOpen] = useState(false);
  const { bandOwner } = useBandOwner("locker");
  const { confirmDestructive, confirmSheet } = useConfirmDestructive();
  useLockerBoundary();
  const vault = useLockerVault();

  const gate = {
    locked:
      vault.session.phase === "locked" || vault.session.phase === "unknown",
    denied: vault.denied !== null,
    // The shell walls the viewer seat before this app mounts; on the phone the
    // seat is `origin`, so this is always false and the flag exists so the rule
    // is stated in one place rather than assumed.
    refused: false,
  };
  const walled = suppressesNavigation(gate);
  const wallMode = gate.denied ? ("denied" as const) : ("lock" as const);
  const headRoute: LockerRouteKey = walled
    ? gate.denied
      ? route
      : "lock"
    : route;

  const onDestination = (key: LockerBandDestinationKey): void => {
    if (key === "more") {
      setMoreOpen(true);
      return;
    }
    // popTo, never navigate: navigate would push a second copy of the list.
    navigation.popTo("LockerHome", { destination: key });
  };

  const onMoreRow = (key: LockerMoreRowKey): void => {
    setMoreOpen(false);
    // Literal screen name per call: navigate's tuple overloads need one.
    const screen = resolveLockerMoreRoute(key);
    switch (screen) {
      case "LockerAccess":
        navigation.navigate("LockerAccess");
        break;
      case "LockerTrash":
        navigation.navigate("LockerTrash");
        break;
      case "LockerSurface":
        // Narrowed by the resolver: only the three elsewhere-surfaces route
        // here, and `resolveLockerMoreRoute` is exhaustive over the rest.
        if (key === "access" || key === "trash") return;
        navigation.navigate("LockerSurface", { surface: key });
        break;
      default: {
        const exhaustive: never = screen;
        throw new Error(`Unhandled More screen: ${String(exhaustive)}`);
      }
    }
  };

  const body = (
    <>
      {/* FIVE MINUTES, SLIDING WITH ACTIVITY. Every touch anywhere in a
          Locker surface restarts the window from now — which is what makes it
          sliding rather than a fixed five minutes from unlock. */}
      <View onTouchStart={noteLockerActivity} style={styles.body}>
        {walled ? (
          <LockerWall
            busy={vault.busy}
            error={vault.session.error}
            mode={wallMode}
            notEnrolled={vault.notEnrolled}
            onForgetKey={() =>
              // #1015, locker/findings #3: the one IRREVERSIBLE act in this
              // app was the only one with no guard and no acknowledgement,
              // while a 30-day-restorable trash of one item had both.
              confirmDestructive({
                body: DEVICE_FORGET_BODY,
                noun: DEVICE_FORGET_NOUN,
                onConfirm: () => {
                  void forgetLockerVaultKey().then(() => {
                    postStatus(DEVICE_FORGET_DONE);
                  });
                },
                verb: DEVICE_FORGET,
              })
            }
            onUnlock={() => void unlockLocker()}
          />
        ) : (
          children
        )}
      </View>

      {confirmSheet}

      <LockerMoreSheet
        onClose={() => setMoreOpen(false)}
        onSelect={onMoreRow}
        visible={moreOpen && !walled}
      />

      {/* A hidden window ends the session at once; this is what the OS
          screenshots for the app switcher instead of a list of titles. */}
      {vault.masked ? (
        <View
          accessibilityLabel={MASKED_LABEL}
          style={[styles.mask, { backgroundColor: colors.bg }]}
        >
          <Text style={[t("small"), { color: colors.textSoft }]}>
            {MASKED_LABEL}
          </Text>
        </View>
      ) : null}
    </>
  );

  // Locker has no selection mode, so the band the room hands back is always
  // live; behind the wall there is no band at all.
  const band =
    walled || hideBand === true
      ? undefined
      : (): React.JSX.Element => (
          <LockerBand
            destination={lockerDestinationFor(headRoute)}
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

  if (isLockerPlace(headRoute))
    return (
      <AppPlace
        app={{
          color: META.color,
          iconKey: META.iconKey,
          subtitle: ROUTE_STATUS[headRoute] ?? "",
          title: ROUTE_TITLE[headRoute],
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
      backTo={lockerParentPlace(headRoute)}
      band={band}
      lockup={lockup}
      onBack={leave}
      title={ROUTE_TITLE[headRoute]}
    >
      {body}
    </PushedPage>
  );
}

const styles = StyleSheet.create({
  body: { flex: 1 },
  mask: {
    alignItems: "center",
    bottom: 0,
    insetInlineEnd: 0,
    insetInlineStart: 0,
    justifyContent: "center",
    position: "absolute",
    top: 0,
  },
});
