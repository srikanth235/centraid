// The two facts true on EVERY route: which vault, which gateway. No greeting.
// The mark IS the vault switch. The gateway line is mono and says offline in
// place, never a banner. Exactly the band's two verbs (:3480), never a third.

import React, { useMemo } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import Svg, { Path } from "react-native-svg";

import { iconChipFinish, radii } from "@centraid/design";

import Icon from "../../kit/components/Icon";
import { Text } from "../../kit/components/NativeText";
import { TEST_IDS } from "../../kit/test-ids";
import { borders, pageMargin, t, useTheme } from "../../kit/theme";
import type { ThemeColors } from "../../kit/theme";

/** :5363. A wash-ground chip, never a solid avatar. */
const MARK = 30;

/** :3446, inlined: the `Icon` registry has no such glyph. */
const NEW_CHAT_PATHS = [
  "M21 15a2 2 0 0 1-2 2H8l-4 4V5a2 2 0 0 1 2-2h13a2 2 0 0 1 2 2z",
  "M9 10h6M12 7v6",
];

function NewChatIcon({ color }: { color: string }): React.JSX.Element {
  return (
    <Svg width={16} height={16} viewBox="0 0 24 24" fill="none">
      {NEW_CHAT_PATHS.map((d) => (
        <Path
          key={d}
          d={d}
          stroke={color}
          strokeWidth={1.5}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ))}
    </Svg>
  );
}

export interface VaultHeaderProps {
  vaultName: string | undefined;
  gatewayName: string | undefined;
  color: string | undefined;
  offline: boolean;
  onSwitchVault: () => void;
  onSearch: () => void;
  onNewChat: () => void;
}

/** No name is a real state; never render a blank lockup. */
const NO_VAULT = "No vault yet";
const NO_GATEWAY = "not connected to a gateway";

export default function VaultHeader({
  vaultName,
  gatewayName,
  color,
  offline,
  onSwitchVault,
  onSearch,
  onNewChat,
}: VaultHeaderProps): React.JSX.Element {
  const { colors, scheme } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const name = vaultName?.trim() || NO_VAULT;
  const hue = /^#[0-9a-fA-F]{6}$/u.test(color ?? "") ? color : colors.text;
  // `iconChipFinish` owns the wash and contrast maths (:5365).
  const finish = iconChipFinish(hue ?? colors.text, colors.bg, scheme);
  const gateway = gatewayName?.trim();
  const line = gateway
    ? offline
      ? `${gateway} · offline`
      : gateway
    : NO_GATEWAY;

  return (
    <View style={styles.row}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${name} on ${line}. Switch vault`}
        onPress={onSwitchVault}
        style={({ pressed }) => [styles.lockup, pressed && styles.pressed]}
        // The label carries the vault's and gateway's names, so it is different
        // on every device; the handle is not.
        testID={TEST_IDS.home.vaultSwitch}
      >
        <View
          style={[styles.mark, { backgroundColor: finish.backgroundColor }]}
        >
          <Text style={[styles.markInitial, { color: finish.markColor }]}>
            {(name[0] ?? "?").toUpperCase()}
          </Text>
        </View>
        {/* The container's label REPLACES these lines to assistive tech. */}
        <View style={styles.names} accessibilityElementsHidden>
          <Text numberOfLines={1} style={styles.vault}>
            {name}
          </Text>
          <Text numberOfLines={1} style={styles.gateway}>
            {line}
          </Text>
        </View>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Search everything"
        onPress={onSearch}
        hitSlop={10}
        style={({ pressed }) => [styles.action, pressed && styles.pressed]}
      >
        <Icon name="Search" size={16} color={colors.textSoft} />
      </Pressable>
      {/* Outlined here, filled only inside the band (:3474). */}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="New chat"
        onPress={onNewChat}
        hitSlop={10}
        style={({ pressed }) => [styles.action, pressed && styles.pressed]}
      >
        <NewChatIcon color={colors.textSoft} />
      </Pressable>
    </View>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    // Bounded (:5461), never borderless.
    action: {
      alignItems: "center",
      borderColor: colors.lineStrong,
      borderRadius: radii.md,
      borderWidth: borders.hairline,
      height: 34,
      justifyContent: "center",
      width: 34,
    },
    gateway: { ...t("mono"), color: colors.textFaint },
    lockup: {
      alignItems: "center",
      flex: 1,
      flexDirection: "row",
      gap: 12,
    },
    mark: {
      alignItems: "center",
      // Static 8 (:5363), not `iconChipRadius()` — that is for app chips.
      borderRadius: radii.md,
      height: MARK,
      justifyContent: "center",
      width: MARK,
    },
    markInitial: {
      ...t("smallStrong"),
    },
    names: { flex: 1 },
    pressed: { backgroundColor: colors.bgPress },
    row: {
      alignItems: "center",
      flexDirection: "row",
      gap: 12,
      paddingBottom: 8,
      paddingHorizontal: pageMargin,
      paddingTop: 12,
    },
    vault: { ...t("smallStrong"), color: colors.text },
  });
