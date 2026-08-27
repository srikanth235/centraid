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
// `gatedShelf` decides WHICH wall: a vault with no passphrase is at setup,
// full stop, whatever route the member last asked for.

import { useNavigation } from "@react-navigation/native";
import React, { useMemo, useState } from "react";
import { StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import {
  gatedShelf,
  SETUP,
  suppressesNavigation,
} from "@centraid/blueprints/apps/locker/shelves";
import {
  ROUTE_STATUS,
  ROUTE_TITLE,
} from "@centraid/blueprints/apps/locker/view-copy";

import { useBandOwner } from "../../kit/band/band-owner";
import AppHeader from "../../kit/components/AppHeader";
import { Text } from "../../kit/components/NativeText";
import { t, useTheme } from "../../kit/theme";
import { resolveAppMeta } from "../../lib/gateway";
import type { LockerShellNavigation } from "../../navigation";
import { resolveLockerMoreRoute } from "./locker-band";
import type { LockerBandDestinationKey, LockerMoreRowKey } from "./locker-band";
import { MASKED_LABEL } from "./locker-seat-copy";
import {
  noteLockerActivity,
  revokeLockerDevice,
  unlockLocker,
  unlockLockerWithDevice,
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
export type LockerRouteKey = keyof typeof ROUTE_TITLE;

export interface LockerScreenProps {
  /** Which band tab this surface belongs under. A More destination is `more`:
   *  the sheet is how the member got here, and lighting one of the other four
   *  would point at a place they are not looking at. */
  current: LockerBandDestinationKey;
  route: LockerRouteKey;
  /** Back to the list, or nothing where the surface IS the list. */
  onBack?: () => void;
  /** The Viewer never draws the band — nor does a route that is a subject
   *  rather than a place. */
  hideBand?: boolean;
  children: React.ReactNode;
}

export default function LockerScreen({
  current,
  route,
  onBack,
  hideBand,
  children,
}: LockerScreenProps): React.JSX.Element {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<LockerShellNavigation>();
  const [moreOpen, setMoreOpen] = useState(false);
  const { bandOwner } = useBandOwner("locker");
  useLockerBoundary();
  const vault = useLockerVault();

  const gate = {
    setup: vault.session.phase === "setup",
    locked:
      vault.session.phase === "locked" || vault.session.phase === "unknown",
    denied: vault.denied !== null,
    // The shell walls the viewer seat before this app mounts; on the phone the
    // seat is `origin`, so this is always false and the flag exists so the rule
    // is stated in one place rather than assumed.
    refused: false,
  };
  const walled = suppressesNavigation(gate);
  const shelf = gatedShelf(gate, null);
  const wallMode = gate.denied
    ? ("denied" as const)
    : shelf === SETUP
      ? ("setup" as const)
      : ("lock" as const);
  const headRoute: LockerRouteKey = walled
    ? gate.denied
      ? route
      : shelf === SETUP
        ? "setup"
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
        title={ROUTE_TITLE[headRoute]}
        subtitle={ROUTE_STATUS[headRoute] ?? ""}
        color={META.color}
        iconKey={META.iconKey}
        onBack={onBack ?? (() => navigation.popTo("Home"))}
      />

      {/* FIVE MINUTES, SLIDING WITH ACTIVITY. Every touch anywhere in a
          Locker surface restarts the window from now — which is what makes it
          sliding rather than a fixed five minutes from unlock. */}
      <View onTouchStart={noteLockerActivity} style={styles.body}>
        {walled ? (
          <LockerWall
            mode={wallMode}
            busy={vault.busy}
            error={vault.session.error}
            deviceEnrolled={vault.credentialId !== null}
            onSubmit={(secret) => void unlockLocker(secret)}
            onDeviceUnlock={() => void unlockLockerWithDevice()}
            onRevokeDevice={() => void revokeLockerDevice()}
          />
        ) : (
          children
        )}
      </View>

      {walled || hideBand ? null : (
        <LockerBand
          owner={bandOwner}
          current={current}
          onSelect={onDestination}
          onHome={() => navigation.popTo("Home")}
        />
      )}

      <LockerMoreSheet
        visible={moreOpen && !walled}
        onClose={() => setMoreOpen(false)}
        onSelect={onMoreRow}
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
    </View>
  );
}

const styles = StyleSheet.create({
  body: { flex: 1 },
  frame: { flex: 1 },
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
