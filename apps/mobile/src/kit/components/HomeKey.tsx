import React from "react";
import { Pressable, StyleSheet } from "react-native";

import { borders, useTheme } from "../theme";
import type { ThemeColors } from "../theme";
import Icon from "./Icon";

// Shared app-exit: ink GRID on a plate = leave to the springboard. Never a
// house (ambiguous as app-home vs launcher). Up-one-level stays the caller's
// chevron. Opaque paper plate — no blur/tint/shadow/teal: glass would float
// over the page and glyph contrast would depend on whatever sits underneath.
//
// Caller owns dismissal. There is ONE placement: the leading control in the
// page's own head row, beside its bar. The bottom-centred `floating` variant
// is deleted (#1015, S6 — audit B14): it was absolutely positioned on the
// bottom edge, which is where every screen in this product already puts
// something — a band, a docked health line, the last list row — so it sat ON
// the standing health line on Data and Devices and covered a row on the rest.
// Screens paid for it with a `BOTTOM_ROOM` constant each, invented per screen,
// and the key still landed on the line. A header control cannot collide with
// anything, and Connectors was already doing exactly that.

const HEADER_SIZE = 40;
const PLATE_RADIUS = 12;

export interface HomeKeyProps {
  onPress: () => void;
}

export default function HomeKey({ onPress }: HomeKeyProps): React.JSX.Element {
  const { colors } = useTheme();
  const styles = React.useMemo(() => makeStyles(colors), [colors]);

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Back to your apps"
      onPress={onPress}
      style={[styles.plate, styles.headerKey]}
    >
      <Icon name="Grid" size={19} color={colors.text} />
    </Pressable>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    headerKey: {
      height: HEADER_SIZE,
      width: HEADER_SIZE,
    },
    // Opaque paper, hairline, 12px. Anything else is glass creeping back.
    plate: {
      alignItems: "center",
      backgroundColor: colors.bg,
      borderColor: colors.lineStrong,
      borderRadius: PLATE_RADIUS,
      borderWidth: borders.hairline,
      justifyContent: "center",
      overflow: "hidden",
    },
  });
