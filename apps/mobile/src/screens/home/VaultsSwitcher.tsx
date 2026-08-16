// governance: allow-repo-hygiene file-size-limit cohesive Vaults switcher sheet (identity list + add/switch/forget + pair entry); decompose in a follow-up (#498)
// The Vaults switcher — the phone's picker over its device-local (gateway,
// vault) tuples (lib/vault-links). Reached by tapping the identity head in the VaultLink
// drawer. It is the ONE surface that does add / switch / delete of Vaults:
//
//   • switch — tap a saved VaultLink; the whole app (app grid, replica, every vault
//     fetch) re-points at it (phone-link.switchVaultLink restarts the tunnel when
//     the gateway changes; same-gateway is just a vault-header + replica re-key).
//   • add    — a vault the active gateway exposes but the phone hasn't saved yet
//     (from listVaults) joins with one tap; a whole new desktop is added by
//     pairing (routed to Settings, which owns the QR scanner).
//   • delete — "Remove from this phone" forgets a tuple locally. The vault stays
//     on the gateway; deleting a vault itself is an admin act on the host (#289).
//
// Form: a bottom sheet in the springboard idiom — serif title, per-vault colour
// accents, a prominent active card. Mechanics mirror the VaultLink/Photos drawers (a
// transparent Modal, an Animated slide, a fading scrim that closes on tap).

import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  Alert,
  Animated,
  Easing,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { icons as ICON_SET, identityInk } from "@centraid/design";
import type { IconName } from "@centraid/design";

import Grabber from "../../kit/components/Grabber";
import Icon from "../../kit/components/Icon";
import { Text } from "../../kit/components/NativeText";
import { useAnimatedValue } from "../../kit/hooks/useAnimatedValue";
import {
  motionDuration,
  useReducedMotion,
} from "../../kit/hooks/useReducedMotion";
import { family, radii, t, useTheme } from "../../kit/theme";
import type { ThemeColors } from "../../kit/theme";
import { listVaults } from "../../lib/gateway";
import type { VaultRow } from "../../lib/gateway";
import { forgetVaultLink, switchVaultLink } from "../../lib/phone-link";
import {
  addActiveGatewayVault,
  getActiveVaultLink,
  listVaultLinks,
  noteActiveVaultMeta,
  subscribeVaultLinks,
} from "../../lib/vault-links";
import type { VaultLink } from "../../lib/vault-links";

const DEFAULT_ICON: IconName = "Sparkle";
const SHEET_TRAVEL = 720; // ≥ max sheet height, so the closed sheet sits fully off-screen.

export interface VaultsSwitcherProps {
  open: boolean;
  onClose: () => void;
  /** Route to the desktop-pairing flow (Settings owns the QR scanner). */
  onPairDesktop: () => void;
}

/** A saved VaultLink, or a vault the active gateway offers that isn't saved yet. */
type AddableVault = {
  vaultId: string;
  name: string;
  color?: string;
  icon?: string;
};

function iconOf(value: string | undefined): IconName {
  return value !== undefined && value in ICON_SET
    ? (value as IconName)
    : DEFAULT_ICON;
}

// Re-read the registry into the sheet's local mirrors. Outside the component so
// both the subscription and the on-open refresh share one definition and the
// effects stay plain external-system reads.
function syncFromRegistry(
  setVaultLinks: (next: VaultLink[]) => void,
  setActiveId: (next: string | undefined) => void
): void {
  setVaultLinks([...listVaultLinks()]);
  setActiveId(getActiveVaultLink()?.id);
}

export default function VaultsSwitcher({
  open,
  onClose,
  onPairDesktop,
}: VaultsSwitcherProps): React.JSX.Element {
  const { colors } = useTheme();
  const reducedMotion = useReducedMotion();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const insets = useSafeAreaInsets();
  const slide = useAnimatedValue(SHEET_TRAVEL);
  const fade = useAnimatedValue(0);

  // Local mirrors of the registry, kept live via subscribeVaultLinks so a switch/add/
  // forget from within this sheet re-renders it immediately.
  const [vaultLinks, setVaultLinks] = useState<VaultLink[]>(() =>
    listVaultLinks()
  );
  const [activeId, setActiveId] = useState<string | undefined>(
    () => getActiveVaultLink()?.id
  );
  const [addable, setAddable] = useState<AddableVault[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(
    () =>
      subscribeVaultLinks(() => syncFromRegistry(setVaultLinks, setActiveId)),
    []
  );

  // On open: animate in, and refresh the addable list from the active gateway.
  useEffect(() => {
    if (!open) return;
    syncFromRegistry(setVaultLinks, setActiveId);
    slide.setValue(SHEET_TRAVEL);
    fade.setValue(0);
    Animated.parallel([
      Animated.timing(slide, {
        toValue: 0,
        duration: motionDuration(300, reducedMotion),
        easing: Easing.bezier(0.2, 0.8, 0.2, 1),
        useNativeDriver: true,
      }),
      Animated.timing(fade, {
        toValue: 1,
        duration: motionDuration(220, reducedMotion),
        easing: Easing.out(Easing.quad),
        useNativeDriver: true,
      }),
    ]).start();

    let cancelled = false;
    void listVaults()
      .then((vaults) => {
        if (cancelled || !vaults) return;
        // Enrich the active VaultLink's cached presentation so its card shows the
        // vault's real name/colour/icon even before the next connect.
        const active = getActiveVaultLink();
        const activeRow =
          active && vaults.find((v) => v.vaultId === active.vaultId);
        if (activeRow) {
          void noteActiveVaultMeta({
            vaultName: activeRow.name,
            color: activeRow.color,
            icon: activeRow.icon,
          });
        }
        const saved = new Set(
          listVaultLinks()
            .map((s) => s.vaultId)
            .filter(Boolean)
        );
        setAddable(
          vaults
            .filter((v: VaultRow) => !saved.has(v.vaultId))
            .map((v) => ({
              vaultId: v.vaultId,
              name: v.name,
              color: v.color,
              icon: v.icon,
            }))
        );
      })
      .catch(() => {
        // Offline / no vault plane — saved Vaults still switch; nothing to add.
        if (!cancelled) setAddable([]);
      });
    return () => {
      cancelled = true;
    };
  }, [fade, open, reducedMotion, slide]);

  const runExclusive = useCallback(
    async (action: () => Promise<unknown>): Promise<void> => {
      if (busy) return;
      setBusy(true);
      try {
        await action();
      } finally {
        setBusy(false);
      }
    },
    [busy]
  );

  const onSwitch = useCallback(
    (vault: VaultLink): void => {
      if (vault.id === activeId) {
        onClose();
        return;
      }
      void runExclusive(async () => {
        await switchVaultLink(vault.id);
        onClose();
      });
    },
    [activeId, onClose, runExclusive]
  );

  const onAdd = useCallback(
    (vault: AddableVault): void => {
      void runExclusive(async () => {
        await addActiveGatewayVault({
          vaultId: vault.vaultId,
          vaultName: vault.name,
          color: vault.color,
          icon: vault.icon,
        });
        onClose();
      });
    },
    [onClose, runExclusive]
  );

  const onForget = useCallback(
    (vault: VaultLink): void => {
      const label = vault.vaultName || vault.desktopName || "this vault";
      Alert.alert(
        "Remove from this phone?",
        `“${label}” will be removed from this iPhone. The vault itself stays on ${
          vault.desktopName || "the desktop"
        } — you can add it again by pairing.`,
        [
          { style: "cancel", text: "Cancel" },
          {
            style: "destructive",
            text: "Remove",
            onPress: () => void runExclusive(() => forgetVaultLink(vault.id)),
          },
        ]
      );
    },
    [runExclusive]
  );

  const active = vaultLinks.find((s) => s.id === activeId);
  const others = vaultLinks.filter((s) => s.id !== activeId);

  return (
    <Modal
      visible={open}
      transparent
      animationType="none"
      onRequestClose={onClose}
    >
      <View style={styles.root}>
        <Animated.View style={[styles.scrim, { opacity: fade }]}>
          <Pressable
            style={StyleSheet.absoluteFill}
            accessibilityLabel="Close vault switcher"
            onPress={onClose}
          />
        </Animated.View>

        <Animated.View
          style={[
            styles.sheet,
            {
              paddingBottom: insets.bottom + 14,
              transform: [{ translateY: slide }],
            },
          ]}
        >
          <Grabber />
          <Text style={styles.eyebrow}>ON THIS IPHONE</Text>
          <Text style={styles.title}>Vaults</Text>

          <ScrollView
            style={styles.scroll}
            contentContainerStyle={styles.scrollBody}
            showsVerticalScrollIndicator={false}
          >
            {active ? (
              <ActiveCard colors={colors} styles={styles} vault={active} />
            ) : (
              <Text style={styles.empty}>
                No vault yet — pair a desktop to connect one.
              </Text>
            )}

            {others.length > 0 ? (
              <>
                <Text style={styles.sectionLabel}>SWITCH TO</Text>
                {others.map((vault) => (
                  <VaultLinkRow
                    key={vault.id}
                    colors={colors}
                    styles={styles}
                    vault={vault}
                    disabled={busy}
                    onPress={() => onSwitch(vault)}
                    onForget={() => onForget(vault)}
                  />
                ))}
              </>
            ) : null}

            {addable.length > 0 ? (
              <>
                <Text style={styles.sectionLabel}>
                  ADD{" "}
                  {active?.desktopName
                    ? `FROM ${active.desktopName.toUpperCase()}`
                    : "A VAULT"}
                </Text>
                {addable.map((vault) => (
                  <AddRow
                    key={vault.vaultId}
                    colors={colors}
                    styles={styles}
                    vault={vault}
                    disabled={busy}
                    onPress={() => onAdd(vault)}
                  />
                ))}
              </>
            ) : null}

            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Pair another desktop"
              onPress={() => {
                onClose();
                onPairDesktop();
              }}
              style={({ pressed }) => [
                styles.pairRow,
                pressed && styles.pressed,
              ]}
            >
              <View style={styles.pairIcon}>
                <Icon name="Bolt" size={18} color={colors.accent} />
              </View>
              <View style={styles.rowMeta}>
                <Text style={styles.pairTitle}>Pair another desktop</Text>
                <Text style={styles.rowSub} numberOfLines={1}>
                  Scan a “Connect phone” code to add a gateway
                </Text>
              </View>
              <Icon name="ChevronRight" size={16} color={colors.textGhost} />
            </Pressable>
          </ScrollView>
        </Animated.View>
      </View>
    </Modal>
  );
}

/** The prominent card for the currently-active VaultLink. */
function ActiveCard({
  colors,
  styles,
  vault,
}: {
  colors: ThemeColors;
  styles: ReturnType<typeof makeStyles>;
  vault: VaultLink;
}): React.JSX.Element {
  const tint = vault.color ?? colors.accent;
  const resolving = vault.vaultId === "";
  return (
    <View
      style={[
        styles.activeCard,
        { backgroundColor: washFor(tint), borderColor: tint },
      ]}
    >
      <View style={[styles.emblem, { backgroundColor: tint }]}>
        <Icon
          name={iconOf(vault.icon)}
          size={24}
          color={identityInk(tint, colors.text, colors.textInv)}
        />
      </View>
      <View style={styles.rowMeta}>
        <Text style={styles.activeName} numberOfLines={1}>
          {vault.vaultName || vault.desktopName || "Your vault"}
        </Text>
        <Text style={styles.activeSub} numberOfLines={1}>
          {resolving ? "Setting up…" : vault.desktopName || "This vault"}
        </Text>
      </View>
      <View style={[styles.activePill, { backgroundColor: tint }]}>
        <Text
          style={[
            styles.activePillText,
            { color: identityInk(tint, colors.text, colors.textInv) },
          ]}
        >
          ACTIVE
        </Text>
      </View>
    </View>
  );
}

/** A saved VaultLink that isn't active — tap to switch, trailing control to forget. */
function VaultLinkRow({
  colors,
  styles,
  vault,
  disabled,
  onPress,
  onForget,
}: {
  colors: ThemeColors;
  styles: ReturnType<typeof makeStyles>;
  vault: VaultLink;
  disabled: boolean;
  onPress: () => void;
  onForget: () => void;
}): React.JSX.Element {
  const tint = vault.color ?? colors.accent;
  return (
    <View style={styles.row}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Switch to ${vault.vaultName || vault.desktopName || "vault"}`}
        disabled={disabled}
        onPress={onPress}
        style={({ pressed }) => [styles.rowMain, pressed && styles.pressed]}
      >
        <View style={[styles.dot, { backgroundColor: tint }]}>
          <Icon
            name={iconOf(vault.icon)}
            size={16}
            color={identityInk(tint, colors.text, colors.textInv)}
          />
        </View>
        <View style={styles.rowMeta}>
          <Text style={styles.rowName} numberOfLines={1}>
            {vault.vaultName || vault.desktopName || "VaultLink"}
          </Text>
          <Text style={styles.rowSub} numberOfLines={1}>
            {vault.desktopName ||
              (vault.vaultId === "" ? "Setting up…" : "Saved")}
          </Text>
        </View>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Remove ${vault.vaultName || vault.desktopName || "vault"} from this phone`}
        hitSlop={10}
        disabled={disabled}
        onPress={onForget}
        style={({ pressed }) => [styles.forget, pressed && styles.pressed]}
      >
        <Icon name="Trash" size={17} color={colors.textFaint} />
      </Pressable>
    </View>
  );
}

/** A vault the active gateway exposes that isn't saved yet — tap to add. */
function AddRow({
  colors,
  styles,
  vault,
  disabled,
  onPress,
}: {
  colors: ThemeColors;
  styles: ReturnType<typeof makeStyles>;
  vault: AddableVault;
  disabled: boolean;
  onPress: () => void;
}): React.JSX.Element {
  const tint = vault.color ?? colors.accent;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Add ${vault.name}`}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.row,
        styles.addRow,
        pressed && styles.pressed,
      ]}
    >
      <View style={[styles.dot, styles.dotHollow, { borderColor: tint }]}>
        <Icon name={iconOf(vault.icon)} size={16} color={tint} />
      </View>
      <View style={styles.rowMeta}>
        <Text style={styles.rowName} numberOfLines={1}>
          {vault.name}
        </Text>
        <Text style={styles.rowSub} numberOfLines={1}>
          Not on this phone yet
        </Text>
      </View>
      <Icon name="Plus" size={18} color={colors.accent} />
    </Pressable>
  );
}

// A translucent wash of the vault colour for the active card. The palette hexes
// are opaque, so append an alpha byte (~12%) to the #rrggbb; non-hex tints fall
// back to a neutral elevated surface handled by the caller's border.
function washFor(hex: string): string {
  return /^#[0-9a-fA-F]{6}$/u.test(hex) ? `${hex}1f` : "transparent";
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    activeCard: {
      alignItems: "center",
      borderRadius: radii.lg,
      borderWidth: 1,
      flexDirection: "row",
      gap: 14,
      marginBottom: 20,
      padding: 16,
    },
    activeName: {
      ...t("title"),
      color: colors.text,
    },
    activePill: {
      borderRadius: radii.md,
      paddingHorizontal: 8,
      paddingVertical: 3,
    },
    activePillText: {
      fontFamily: family.sansMedium,
      fontSize: t("mono").fontSize,
      letterSpacing: 1,
    },
    activeSub: { ...t("small"), color: colors.textFaint, marginTop: 3 },
    addRow: { marginBottom: 8 },
    dot: {
      alignItems: "center",
      borderRadius: radii.lg,
      height: 40,
      justifyContent: "center",
      width: 40,
    },
    dotHollow: { backgroundColor: "transparent", borderWidth: 1.5 },
    emblem: {
      alignItems: "center",
      borderRadius: radii.lg,
      height: 52,
      justifyContent: "center",
      width: 52,
    },
    empty: {
      ...t("body"),
      color: colors.textFaint,
      marginBottom: 20,
      paddingVertical: 8,
    },
    eyebrow: {
      color: colors.textFaint,
      fontFamily: family.sansMedium,
      fontSize: t("control").fontSize,
      letterSpacing: 1,
      marginTop: 2,
      paddingHorizontal: 20,
    },
    forget: {
      alignItems: "center",
      height: 44,
      justifyContent: "center",
      width: 44,
    },
    pairIcon: {
      alignItems: "center",
      backgroundColor: colors.bg,
      borderColor: colors.line,
      borderRadius: radii.lg,
      borderWidth: 1,
      height: 40,
      justifyContent: "center",
      width: 40,
    },
    pairRow: {
      alignItems: "center",
      backgroundColor: colors.bg,
      borderColor: colors.line,
      borderRadius: radii.md,
      borderWidth: 1,
      flexDirection: "row",
      gap: 13,
      marginTop: 12,
      paddingHorizontal: 12,
      paddingVertical: 12,
    },
    pairTitle: { ...t("bodyStrong"), color: colors.text },
    pressed: { opacity: 0.55 },
    root: { flex: 1, justifyContent: "flex-end" },
    row: {
      alignItems: "center",
      flexDirection: "row",
      gap: 4,
    },
    rowMain: {
      alignItems: "center",
      flex: 1,
      flexDirection: "row",
      gap: 13,
      paddingVertical: 10,
    },
    rowMeta: { flex: 1, minWidth: 0 },
    rowName: { ...t("bodyStrong"), color: colors.text },
    rowSub: { ...t("small"), color: colors.textFaint, marginTop: 2 },
    scroll: { flexGrow: 0 },
    scrollBody: { paddingHorizontal: 20, paddingTop: 18 },
    sectionLabel: {
      color: colors.textFaint,
      fontFamily: family.sansMedium,
      fontSize: t("control").fontSize,
      letterSpacing: 0.9,
      marginBottom: 4,
      marginTop: 10,
    },
    sheet: {
      backgroundColor: colors.bgElev,
      borderTopLeftRadius: radii.lg,
      borderTopRightRadius: radii.lg,
      maxHeight: "86%",
      paddingTop: 6,
    },
    scrim: { backgroundColor: colors.scrim, ...StyleSheet.absoluteFill },
    title: {
      ...t("display"),
      color: colors.text,
      marginTop: 2,
      paddingHorizontal: 20,
    },
  });
