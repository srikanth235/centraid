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
import VaultBar from "../../screens/home/VaultBar";
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

export type LockerRouteKey = keyof typeof ROUTE_TITLE;

export interface LockerScreenProps {
  current: LockerBandDestinationKey;
  route: LockerRouteKey;
  onBack?: () => void;
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
    navigation.popTo("LockerHome", { destination: key });
  };

  const onMoreRow = (key: LockerMoreRowKey): void => {
    setMoreOpen(false);
    const screen = resolveLockerMoreRoute(key);
    switch (screen) {
      case "LockerAccess":
        navigation.navigate("LockerAccess");
        break;
      case "LockerTrash":
        navigation.navigate("LockerTrash");
        break;
      case "LockerSurface":
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
      {/* The vault lockup on every route (see `VaultBar`): which vault, which
          gateway, and the product's two global verbs. Above the app's own
          header, which names the ROUTE — a different question. */}
      <VaultBar />
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
