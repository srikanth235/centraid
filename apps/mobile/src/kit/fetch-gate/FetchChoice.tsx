// The stated-choice UI contract for a gated fetch (`fetchAccess` in
// gate.ts): the preview the caller already holds, plus the one tap that
// spends the bytes. Never a silent fetch on a metered connection when the
// policy says ask, and never a spinner — the shape is known before the bytes
// are, so the shape is drawn and the affordance to go get the rest sits on
// top of it.
//
// Extracted from photos' `MediaPage.tsx` (`MeteredPlaceholder`), generalised
// so a byte-bearing app that isn't Photos — Docs' "available offline" pin
// fetch is the first one named — gets the same grammar for free instead of
// re-deriving it. The geometry matches `PhotoLightbox.styles.ts`'s
// `mediaCenter`/`zoomPill`/`chipText` exactly (radii.pill, 1px border, 44
// minimum target), resolved straight from theme tokens here so this module
// does not depend on a photos-owned stylesheet — a structural move, not a
// visual one.

import React from "react";
import type { StyleProp, ViewStyle } from "react-native";
import { Pressable, StyleSheet, View } from "react-native";

import Icon from "../components/Icon";
import { Text } from "../components/NativeText";
import { radii, spacing, t, useTheme } from "../theme";

const styles = StyleSheet.create({
  center: { alignItems: "center", justifyContent: "center" },
  chip: {
    alignItems: "center",
    borderRadius: radii.pill,
    borderWidth: 1,
    bottom: spacing[3],
    flexDirection: "row",
    gap: spacing[1],
    insetInlineStart: spacing[3],
    minHeight: 44,
    paddingHorizontal: spacing[3],
    position: "absolute",
  },
  chipText: { ...t("control") },
});

/**
 * The tap that spends the bytes. A standalone export because some callers
 * (photos' second "load the original" affordance, kept exactly as-is per
 * the extraction brief) need the chip without the centred preview wrapper.
 */
export function FetchChoiceChip({
  label,
  onPress,
  accessibilityLabel,
  style,
}: {
  label: string;
  onPress: () => void;
  accessibilityLabel: string;
  style?: StyleProp<ViewStyle>;
}): React.JSX.Element {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="button"
      onPress={onPress}
      style={[
        styles.chip,
        { backgroundColor: colors.stage, borderColor: colors.stageLine },
        style,
      ]}
    >
      <Icon name="download" size={15} color={colors.onStage} />
      <Text style={[styles.chipText, { color: colors.onStage }]}>{label}</Text>
    </Pressable>
  );
}

/**
 * The full placeholder: a centred preview (whatever the caller already has —
 * a thumbnail, a poster frame) with the choice chip layered on top. Renders
 * in place of the gated content whenever `fetchAccess` answers `needs-choice`.
 */
export function FetchChoicePlaceholder({
  width,
  height,
  label,
  accessibilityLabel,
  onFetch,
  children,
}: {
  width: number;
  height: number;
  label: string;
  accessibilityLabel: string;
  onFetch: () => void;
  /** The already-available preview — an `<Image>`, a poster `<View>`, etc. */
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <View style={[styles.center, { width, height }]}>
      {children}
      <FetchChoiceChip
        accessibilityLabel={accessibilityLabel}
        label={label}
        onPress={onFetch}
      />
    </View>
  );
}
