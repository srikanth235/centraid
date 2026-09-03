// governance: allow-repo-hygiene file-size-limit cohesive Vaults switcher sheet (identity list + add/switch/forget + pair entry); decompose in a follow-up (#498)

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
import { useReplica } from "../../kit/replica/ReplicaProvider";
import { family, radii, t, useTheme } from "../../kit/theme";
import type { ThemeColors } from "../../kit/theme";
import { listVaults } from "../../lib/gateway";
import type { VaultRow } from "../../lib/gateway";
import { forgetVaultLink, switchVaultLink } from "../../lib/phone-link";
import { MAX_MOUNTED_NATIVE_SCOPES } from "../../lib/replica/offline-budgets";
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

const CAP_NOTE = "Four vaults stay on this phone at a time.";
const RESIDENT_SUB = "On this phone";
const NON_RESIDENT_SUB = "Over the four-vault limit";

export interface VaultsSwitcherProps {
  open: boolean;
  onClose: () => void;
  onPairDesktop: () => void;
}

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

  const [vaultLinks, setVaultLinks] = useState<VaultLink[]>(() =>
    listVaultLinks()
  );
  const [activeId, setActiveId] = useState<string | undefined>(
    () => getActiveVaultLink()?.id
  );
  const [addable, setAddable] = useState<AddableVault[]>([]);
  const [busy, setBusy] = useState(false);
  const { scopes } = useReplica();
  const mountedVaultIds = useMemo(
    () => new Set((scopes ?? []).map((scope) => scope.vaultId)),
    [scopes]
  );

  useEffect(
    () =>
      subscribeVaultLinks(() => syncFromRegistry(setVaultLinks, setActiveId)),
    []
  );

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
  const capped =
    active !== undefined &&
    mountedVaultIds.size > 0 &&
    vaultLinks.filter((s) => s.gatewayId === active.gatewayId).length >
      MAX_MOUNTED_NATIVE_SCOPES;
  const residencyOf = (vault: VaultLink): string | undefined => {
    if (!capped || vault.gatewayId !== active?.gatewayId) return undefined;
    return mountedVaultIds.has(vault.vaultId) ? RESIDENT_SUB : NON_RESIDENT_SUB;
  };

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
                {capped ? (
                  <Text style={styles.sectionNote}>{CAP_NOTE}</Text>
                ) : null}
                {others.map((vault) => (
                  <VaultLinkRow
                    key={vault.id}
                    colors={colors}
                    styles={styles}
                    vault={vault}
                    disabled={busy}
                    residency={residencyOf(vault)}
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

function VaultLinkRow({
  colors,
  styles,
  vault,
  disabled,
  residency,
  onPress,
  onForget,
}: {
  colors: ThemeColors;
  styles: ReturnType<typeof makeStyles>;
  vault: VaultLink;
  disabled: boolean;
  residency?: string;
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
            {residency ||
              vault.desktopName ||
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
    sectionNote: { ...t("small"), color: colors.textFaint, marginBottom: 2 },
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
