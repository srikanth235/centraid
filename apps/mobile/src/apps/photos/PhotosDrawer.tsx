// The Photos navigation drawer — the slide-in sidebar behind the ☰ button in
// the Photos top bar. Ported from the "Centraid Mobile" design (the Photos
// variant of the shared drawer): a profile header, the Photos-specific vault +
// storage + "More from Photos" block, then the Home / Settings footer.
//
// The storage figures ("0.86 GB of 5 TB", the 6% bar) mirror the design mock —
// the phone has no storage-accounting API wired yet, so these are static
// placeholders, not live numbers. The Backup pill reflects the design's "On"
// state. Everything actionable that has no mobile destination yet routes to the
// nearest real screen or surfaces an "on desktop" note, matching how the rest
// of the Photos port handles desktop-only affordances.

import React, { useEffect, useState } from "react";
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
import { getProfileColor, getProfileName, initialsOf } from "../../lib/profile";
import { getActiveVaultLink, subscribeVaultLinks } from "../../lib/vault-links";

const PANEL_WIDTH = 288;
// A ~12%-alpha wash of a 6-hex colour for the accent pill; opaque palette hexes
// get an alpha byte appended, anything else falls back to an elevated surface.
function washFor(hex: string, fallback: string): string {
  return /^#[0-9a-fA-F]{6}$/u.test(hex) ? `${hex}22` : fallback;
}

export type PhotosDrawerProps = {
  visible: boolean;
  onClose: () => void;
  onHome: () => void;
  onSettings: () => void;
  /** Open the Vaults switcher (add / switch / forget device-local vaults). */
  onSwitchVault: () => void;
};

export default function PhotosDrawer({
  visible,
  onClose,
  onHome,
  onSettings,
  onSwitchVault,
}: PhotosDrawerProps): React.JSX.Element {
  const { colors } = useTheme();
  const reducedMotion = useReducedMotion();
  const insets = useSafeAreaInsets();
  const name = getProfileName();
  const color = getProfileColor();
  // The active (gateway, vault) tuple, kept live so the switch card names the
  // vault the app is actually pointed at — not a static placeholder.
  const [vault, setVault] = useState(() => getActiveVaultLink());
  useEffect(
    () => subscribeVaultLinks(() => setVault(getActiveVaultLink())),
    []
  );
  const vaultName =
    vault?.vaultName || vault?.desktopName || name || "Personal vault";
  const vaultColor = vault?.color || color;
  const slide = useAnimatedValue(-PANEL_WIDTH);
  const fade = useAnimatedValue(0);

  useEffect(() => {
    if (!visible) return;
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
  }, [fade, reducedMotion, slide, visible]);

  return (
    <Modal
      visible={visible}
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
          <View style={[styles.profile, { borderBottomColor: colors.line }]}>
            <View style={[styles.avatar, { backgroundColor: color }]}>
              <Text style={styles.avatarText}>{initialsOf(name)}</Text>
            </View>
            <View style={styles.profileMeta}>
              <Text
                style={[styles.profileName, { color: colors.text }]}
                numberOfLines={1}
              >
                {name || "You"}
              </Text>
              <Text style={[styles.profileSub, { color: colors.textFaint }]}>
                Personal vault
              </Text>
            </View>
          </View>

          <View style={styles.scroll}>
            {/* Explicit vault switcher: names the CURRENT vault + a labelled
                "Switch" control, and opens the real Vaults sheet. Replaces the
                old cryptic overlapping-avatars pill, which did nothing. */}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Switch vault. Current vault: ${vaultName}`}
              onPress={onSwitchVault}
              style={({ pressed }) => [
                styles.switchVault,
                { backgroundColor: colors.bgSunken },
                pressed && styles.pressed,
              ]}
            >
              <View
                style={[styles.vaultDot, { backgroundColor: vaultColor }]}
              />
              <View style={styles.switchMeta}>
                <Text
                  style={[styles.switchEyebrow, { color: colors.textFaint }]}
                >
                  CURRENT VAULT
                </Text>
                <Text
                  style={[styles.switchName, { color: colors.text }]}
                  numberOfLines={1}
                >
                  {vaultName}
                </Text>
              </View>
              <View
                style={[
                  styles.switchPill,
                  { backgroundColor: washFor(colors.accent, colors.bgElev) },
                ]}
              >
                <Icon name="chevrons-down" size={13} color={colors.accent} />
                <Text style={[styles.switchPillText, { color: colors.accent }]}>
                  Switch
                </Text>
              </View>
            </Pressable>

            <View
              style={[styles.storageCard, { backgroundColor: colors.bgSunken }]}
            >
              <View style={styles.storageHead}>
                <Icon name="cloud" size={20} color={colors.accent} />
                <Text style={[styles.storageText, { color: colors.text }]}>
                  0.86 GB of 5 TB
                </Text>
              </View>
              <View
                style={[
                  styles.storageTrack,
                  { backgroundColor: colors.bgElev },
                ]}
              >
                <View
                  style={[
                    styles.storageFill,
                    { backgroundColor: colors.accent },
                  ]}
                />
              </View>
              <View style={styles.storageActions}>
                <Pressable>
                  <Text
                    style={[styles.storageAction, { color: colors.accent }]}
                  >
                    Get more
                  </Text>
                </Pressable>
                <Pressable>
                  <Text
                    style={[styles.storageAction, { color: colors.accent }]}
                  >
                    Free up vault
                  </Text>
                </Pressable>
              </View>
            </View>

            <Text style={[styles.sectionLabel, { color: colors.textFaint }]}>
              MORE FROM PHOTOS
            </Text>

            <View style={[styles.row, { borderBottomColor: colors.line }]}>
              <Icon name="cloud" size={19} color={colors.textFaint} />
              <Text style={[styles.rowLabel, { color: colors.text }]}>
                Backup
              </Text>
              <View
                style={[
                  styles.onPill,
                  { backgroundColor: `${colors.success}24` },
                ]}
              >
                <View
                  style={[styles.onDot, { backgroundColor: colors.success }]}
                />
                <Text style={[styles.onText, { color: colors.success }]}>
                  On
                </Text>
              </View>
            </View>

            <Pressable style={[styles.row, { borderBottomColor: colors.line }]}>
              <Icon name="smartphone" size={19} color={colors.textFaint} />
              <Text style={[styles.rowLabel, { color: colors.text }]}>
                Free up vault on device
              </Text>
              <Icon name="chevron-right" size={17} color={colors.textGhost} />
            </Pressable>

            <Pressable style={styles.row}>
              <Icon name="shield" size={19} color={colors.textFaint} />
              <Text style={[styles.rowLabel, { color: colors.text }]}>
                Your data in Centraid
              </Text>
              <Icon name="chevron-right" size={17} color={colors.textGhost} />
            </Pressable>

            <View style={[styles.divider, { backgroundColor: colors.line }]} />

            <Pressable style={styles.footerItem} onPress={onHome}>
              <Icon name="home" size={17} color={colors.textSoft} />
              <Text style={[styles.footerLabel, { color: colors.text }]}>
                Home
              </Text>
            </Pressable>
            <Pressable style={styles.footerItem} onPress={onSettings}>
              <Icon name="settings" size={17} color={colors.textSoft} />
              <Text style={[styles.footerLabel, { color: colors.text }]}>
                Settings
              </Text>
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

const styles = StyleSheet.create({
  avatar: {
    alignItems: "center",
    borderRadius: 21,
    height: 42,
    justifyContent: "center",
    width: 42,
  },
  avatarText: { color: "#fff", fontFamily: family.sansBold, fontSize: 15 },
  divider: { height: 0.5, marginHorizontal: 14, marginVertical: 8 },
  footerItem: {
    alignItems: "center",
    borderRadius: 12,
    flexDirection: "row",
    gap: 13,
    paddingHorizontal: 14,
    paddingVertical: 13,
  },
  footerLabel: { fontFamily: family.sansRegular, fontSize: 15 },
  onDot: { borderRadius: 3, height: 5, width: 5 },
  onPill: {
    alignItems: "center",
    borderRadius: 999,
    flexDirection: "row",
    gap: 5,
    paddingHorizontal: 9,
    paddingVertical: 3,
  },
  onText: { fontFamily: family.sansBold, fontSize: 10 },
  panel: {
    borderRightWidth: 0.5,
    flex: 0,
    height: "100%",
    paddingHorizontal: 0,
    width: PANEL_WIDTH,
  },
  pressed: { opacity: 0.6 },
  profile: {
    alignItems: "center",
    borderBottomWidth: 0.5,
    flexDirection: "row",
    gap: 12,
    paddingBottom: 16,
    paddingHorizontal: 20,
    paddingTop: 6,
  },
  profileMeta: { flex: 1, minWidth: 0 },
  profileName: { fontFamily: family.sansBold, fontSize: 15 },
  profileSub: { fontFamily: family.sansRegular, fontSize: 12, marginTop: 1 },
  root: { flex: 1, flexDirection: "row" },
  row: {
    alignItems: "center",
    borderBottomWidth: 0.5,
    flexDirection: "row",
    gap: 12,
    paddingHorizontal: 2,
    paddingVertical: 11,
  },
  rowLabel: { flex: 1, fontFamily: family.sansRegular, fontSize: 15 },
  scrim: { backgroundColor: "rgba(0,0,0,.4)", flex: 1 },
  scroll: { flex: 1, paddingHorizontal: 10, paddingTop: 10 },
  sectionLabel: {
    fontFamily: family.monoMedium,
    fontSize: 11,
    letterSpacing: 0.9,
    marginBottom: 6,
    marginHorizontal: 2,
    marginTop: 4,
  },
  storageAction: { fontFamily: family.sansBold, fontSize: 15 },
  storageActions: { flexDirection: "row", gap: 18 },
  storageCard: { borderRadius: 12, marginBottom: 12, padding: 13 },
  storageFill: { borderRadius: 4, height: "100%", width: "6%" },
  storageHead: {
    alignItems: "center",
    flexDirection: "row",
    gap: 9,
    marginBottom: 11,
  },
  storageText: { flex: 1, fontFamily: family.sansBold, fontSize: 15 },
  storageTrack: {
    borderRadius: 4,
    height: 7,
    marginBottom: 11,
    overflow: "hidden",
  },
  switchEyebrow: {
    fontFamily: family.monoMedium,
    fontSize: 10,
    letterSpacing: 0.8,
    marginBottom: 2,
  },
  switchMeta: { flex: 1, minWidth: 0 },
  switchName: { fontFamily: family.sansBold, fontSize: 15 },
  switchPill: {
    alignItems: "center",
    borderRadius: 999,
    flexDirection: "row",
    gap: 5,
    paddingHorizontal: 11,
    paddingVertical: 6,
  },
  switchPillText: { fontFamily: family.sansBold, fontSize: 12 },
  switchVault: {
    alignItems: "center",
    borderRadius: 12,
    flexDirection: "row",
    gap: 11,
    marginBottom: 11,
    paddingHorizontal: 13,
    paddingVertical: 11,
  },
  vaultDot: { borderRadius: 6, height: 12, width: 12 },
});
