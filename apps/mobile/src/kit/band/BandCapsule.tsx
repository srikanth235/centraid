// The home capsule, rendered; its model is `band-capsule.ts` (#883).
import React, { useMemo } from "react";
import { StyleSheet } from "react-native";

import { BAND_BORDER, BAND_RADIUS } from "../band-surface";
import Icon from "../components/Icon";
import Tappable from "../components/Tappable";
import { useTheme } from "../theme";
import type { ThemeColors } from "../theme";
import { BAND_CAPSULE } from "./band-capsule";
import type { BandCapsule } from "./band-capsule";

export interface BandCapsuleProps {
  onPress: () => void;
  capsule?: BandCapsule;
  /** Deaf and dim while a selection runs, with the rest of the band (#1015,
   *  D5): the glyph takes `textDisabled`, never a container opacity. */
  disabled?: boolean;
}

export default function BandCapsuleControl({
  onPress,
  capsule = BAND_CAPSULE,
  disabled = false,
}: BandCapsuleProps): React.JSX.Element {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  return (
    <Tappable
      accessibilityLabel={capsule.label}
      disabled={disabled}
      // Already 52 square: the kit's default slop would reach into the tabs.
      hitSlop={0}
      onPress={onPress}
      style={[styles.capsule, { width: capsule.size }]}
    >
      <Icon
        color={disabled ? colors.textDisabled : colors.textSoft}
        name={capsule.icon}
        size={19}
      />
    </Tappable>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    capsule: {
      alignItems: "center",
      // The frame's page colour, never the app's mat.
      backgroundColor: colors.bg,
      borderColor: colors.lineStrong,
      borderRadius: BAND_RADIUS,
      borderWidth: BAND_BORDER,
      justifyContent: "center",
    },
  });
