// The global Vault drawer (issue #498, Slice 4) — the springboard's identity +
// system surface, slid in from the left edge over Home. It is the ONE thing the
// desktop sidebar (packages/client/src/react/shell/Sidebar.tsx) carries that the
// launcher otherwise lacks: a persistent vault head plus a curated menu.
//
// It is deliberately NOT a 1:1 port of the ~17-entry desktop sidebar. The app
// list already IS Home's grid; Search / Settings / Assistant live in the dock;
// Approvals / Automations live in the attention line. So this drawer only adds
// the vault identity header and two short sections (GO TO / SYSTEM). Desktop-only
// rows with no mobile destination (Insights, Starred, Vault Atlas,
// Chats, Backups) are intentionally omitted rather than rendered as dead links.
//
// Mechanics mirror the Photos drawer (src/apps/photos/PhotosDrawer.tsx): a
// transparent Modal, a translateX slide from -width→0 on a bezier, and a fading
// ~40% black scrim that closes on tap. Each row closes the drawer, then routes.

import React, { useEffect, useMemo } from "react";
import {
  Animated,
  Easing,
  Modal,
  Pressable,
  StyleSheet,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import Icon from "../../kit/components/Icon";
import { Text } from "../../kit/components/NativeText";
import { useAnimatedValue } from "../../kit/hooks/useAnimatedValue";
import {
  motionDuration,
  useReducedMotion,
} from "../../kit/hooks/useReducedMotion";
import { family, useTheme } from "../../kit/theme";
import type { ThemeColors } from "../../kit/theme";
import { initialsOf } from "../../lib/profile";
import type { ConnectionState } from "./AttentionLine";

const PANEL_WIDTH = 288;

export interface VaultDrawerProps {
  open: boolean;
  onClose: () => void;
  /** Desktop-link state, shared with Home so the drawer never re-fetches it. */
  connection: ConnectionState;
  /** Pending parked approvals — shown as a badge on the Approvals row. */
  approvals: number;
  /** Local identity: display name + accent, straight from Home's profile state. */
  profile: { name: string; color: string };
  /** Open the Vaults switcher (add / switch / forget device-local vaults). */
  onVaults: () => void;
  onAssistant: () => void;
  onAutomations: () => void;
  onInsights: () => void;
  onApprovals: () => void;
  onSettings: () => void;
}

type ConnTone = "connected" | "idle" | "offline";

// Truthful, one-gateway status derived from the shared ConnectionState — no
// invented "gateway health" beyond what Home already resolved.
function describeConnection(connection: ConnectionState): {
  label: string;
  tone: ConnTone;
} {
  switch (connection.kind) {
    case "ready":
      return { label: "Connected", tone: "connected" };
    case "error":
      return { label: "Desktop offline", tone: "offline" };
    case "loading":
      return { label: "Connecting…", tone: "idle" };
    case "no-gateway":
      return { label: "Not connected", tone: "idle" };
  }
}

export default function VaultDrawer({
  open,
  onClose,
  connection,
  approvals,
  profile,
  onVaults,
  onAssistant,
  onAutomations,
  onInsights,
  onApprovals,
  onSettings,
}: VaultDrawerProps): React.JSX.Element {
  const { colors } = useTheme();
  const reducedMotion = useReducedMotion();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const insets = useSafeAreaInsets();
  const slide = useAnimatedValue(-PANEL_WIDTH);
  const fade = useAnimatedValue(0);

  const status = describeConnection(connection);
  const dotColor =
    status.tone === "connected"
      ? colors.accent
      : status.tone === "offline"
        ? (colors.danger ?? colors.accent)
        : colors.textGhost;

  useEffect(() => {
    if (!open) return;
    slide.setValue(-PANEL_WIDTH);
    fade.setValue(0);
    Animated.parallel([
      Animated.timing(slide, {
        toValue: 0,
        duration: motionDuration(260, reducedMotion),
        easing: Easing.bezier(0.2, 0.7, 0.2, 1),
        useNativeDriver: true,
      }),
      Animated.timing(fade, {
        toValue: 1,
        duration: motionDuration(200, reducedMotion),
        easing: Easing.out(Easing.quad),
        useNativeDriver: true,
      }),
    ]).start();
  }, [fade, open, reducedMotion, slide]);

  // Close first, then route — so the cover we push slides over a dismissed drawer
  // (matches PhotosDrawer's onHome contract).
  const go = (fn: () => void) => (): void => {
    onClose();
    fn();
  };

  return (
    <Modal
      visible={open}
      transparent
      animationType="none"
      onRequestClose={onClose}
    >
      <View style={styles.root}>
        <Animated.View
          style={[
            styles.panel,
            {
              backgroundColor: colors.bgElev,
              borderRightColor: colors.line,
              paddingTop: insets.top + 18,
              paddingBottom: insets.bottom + 20,
              transform: [{ translateX: slide }],
            },
          ]}
        >
          <Pressable
            accessibilityLabel="Switch vault"
            accessibilityRole="button"
            onPress={go(onVaults)}
            style={[styles.header, { borderBottomColor: colors.line }]}
          >
            <View style={[styles.avatar, { backgroundColor: profile.color }]}>
              <Text style={styles.avatarText}>{initialsOf(profile.name)}</Text>
            </View>
            <View style={styles.headerMeta}>
              <Text
                style={[styles.headerName, { color: colors.text }]}
                numberOfLines={1}
              >
                {profile.name || "Your vault"}
              </Text>
              <Text
                style={[styles.headerSub, { color: colors.textFaint }]}
                numberOfLines={1}
              >
                {status.label}
              </Text>
            </View>
            {/* Stacked chevrons = "switch", distinguishing this from the plain nav rows. */}
            <Icon name="chevrons-down" size={17} color={colors.textGhost} />
          </Pressable>

          <View style={styles.scroll}>
            <Text style={styles.sectionLabel}>GO TO</Text>

            <Pressable style={styles.row} onPress={go(onAssistant)}>
              <Icon name="message-circle" size={19} color={colors.textFaint} />
              <Text style={[styles.rowLabel, { color: colors.text }]}>
                Assistant
              </Text>
            </Pressable>

            <Pressable style={styles.row} onPress={go(onAutomations)}>
              <Icon name="zap" size={19} color={colors.textFaint} />
              <Text style={[styles.rowLabel, { color: colors.text }]}>
                Automations
              </Text>
            </Pressable>

            <Pressable style={styles.row} onPress={go(onInsights)}>
              <Icon name="bar-chart-2" size={19} color={colors.textFaint} />
              <Text style={[styles.rowLabel, { color: colors.text }]}>
                Insights
              </Text>
            </Pressable>

            <Pressable style={styles.row} onPress={go(onApprovals)}>
              <Icon name="bell" size={19} color={colors.textFaint} />
              <Text style={[styles.rowLabel, { color: colors.text }]}>
                Notifications
              </Text>
              {approvals > 0 ? (
                <View
                  style={[styles.badge, { backgroundColor: colors.accent }]}
                >
                  <Text style={styles.badgeText}>
                    {approvals > 99 ? "99+" : approvals}
                  </Text>
                </View>
              ) : null}
            </Pressable>

            <View style={[styles.divider, { backgroundColor: colors.line }]} />

            <Text style={styles.sectionLabel}>SYSTEM</Text>

            <Pressable style={styles.row} onPress={go(onSettings)}>
              <Icon name="settings" size={19} color={colors.textFaint} />
              <Text style={[styles.rowLabel, { color: colors.text }]}>
                Settings
              </Text>
            </Pressable>

            {/* Status, not a nav target of its own — pairing lives in Settings. */}
            <Pressable style={styles.row} onPress={go(onSettings)}>
              <View style={[styles.statusDot, { backgroundColor: dotColor }]} />
              <Text style={[styles.rowLabel, { color: colors.text }]}>
                {status.label}
              </Text>
              <Icon name="chevron-right" size={17} color={colors.textGhost} />
            </Pressable>
          </View>
        </Animated.View>

        <Animated.View style={[styles.scrim, { opacity: fade }]}>
          <Pressable
            style={StyleSheet.absoluteFill}
            accessibilityLabel="Close menu"
            onPress={onClose}
          />
        </Animated.View>
      </View>
    </Modal>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    avatar: {
      alignItems: "center",
      borderRadius: 21,
      height: 42,
      justifyContent: "center",
      width: 42,
    },
    avatarText: { color: "#fff", fontFamily: family.sansMedium, fontSize: 15 },
    badge: {
      alignItems: "center",
      borderRadius: 10,
      justifyContent: "center",
      minWidth: 20,
      paddingHorizontal: 5,
      paddingVertical: 1,
    },
    badgeText: { color: "#fff", fontFamily: family.sansMedium, fontSize: 11 },
    divider: {
      height: StyleSheet.hairlineWidth,
      marginHorizontal: 2,
      marginVertical: 12,
    },
    header: {
      alignItems: "center",
      borderBottomWidth: 0.5,
      flexDirection: "row",
      gap: 12,
      paddingBottom: 16,
      paddingHorizontal: 20,
      paddingTop: 6,
    },
    headerMeta: { flex: 1, minWidth: 0 },
    headerName: {
      fontFamily: family.displayRegular,
      fontSize: 20,
      letterSpacing: -0.2,
    },
    headerSub: { fontFamily: family.sansRegular, fontSize: 12, marginTop: 2 },
    panel: {
      borderRightWidth: 0.5,
      flex: 0,
      height: "100%",
      width: PANEL_WIDTH,
    },
    root: { flex: 1, flexDirection: "row" },
    row: {
      alignItems: "center",
      flexDirection: "row",
      gap: 13,
      paddingHorizontal: 2,
      paddingVertical: 13,
    },
    rowLabel: { flex: 1, fontFamily: family.sansRegular, fontSize: 15 },
    scrim: { backgroundColor: "rgba(0,0,0,.4)", flex: 1 },
    scroll: { flex: 1, paddingHorizontal: 14, paddingTop: 12 },
    sectionLabel: {
      color: colors.textFaint,
      fontFamily: family.monoMedium,
      fontSize: 11,
      letterSpacing: 0.9,
      marginBottom: 4,
      marginHorizontal: 2,
      marginTop: 4,
    },
    statusDot: { borderRadius: 5, height: 10, marginHorizontal: 5, width: 10 },
  });
