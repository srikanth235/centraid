import React from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { borders, useTheme } from "../theme";
import type { ThemeColors } from "../theme";
import Icon from "./Icon";

// The one "leave this mini-app for your apps" key, shared by every full-page app
// cover so the escape hatch looks and lands the same everywhere. Design grammar:
//
//   • an ink GRID glyph on a plate = "leave to the springboard" (the launcher is
//     a grid of your apps — never a house, which in a super-app reads
//     ambiguously as either this app's home OR the launcher's).
//   • an app's own accent + a chevron = "up one level, still in this app"
//     (Docs folder→parent, Photos album→grid). That stays the caller's own
//     control — this key is only ever the app-exit.
//
// The material is the same statement `PhotosBand`'s capsule makes: the capsule
// is the FRAME's object inside an app's page, so in paper it is an opaque plate
// on the frame's own page colour, a hairline edge and a 12px radius — and
// nothing else. No BlurView, no tint film, no sheen, no shadow, no elevation,
// and no teal wash: the v4 Binding Layer is paper, not glass, and the accent is
// no longer a brand colour to wash chrome with. A key that blurs what is behind
// it would read as a floating pane over the page instead of an object seated on
// it — and over unpredictable content its glyph contrast would depend on what
// happens to be underneath.
//
// The caller owns the dismissal (pop the cover). Two placements of the same
// plate — they differ only in where they sit:
//   • 'floating' — absolute, centered on the bottom edge, for covers with no
//     bottom bar of their own (Insights). `box-none` on the full-width wrap lets
//     taps either side of the plate fall through to the content beneath.
//   • 'leave'    — layout-agnostic plate the caller seats as the LEADING control
//     of a header row (Automations, Docs root, Agenda, Notes, Tasks, Tally,
//     People), vertically centered against the title + subtitle.

// Side of the floating plate. ≥44 keeps it a comfortable tap target.
const FLOAT_SIZE = 54;

// Side of the header-leading plate. A touch smaller than the floating key — it
// reads as header chrome sitting beside a large title, not the page's primary
// exit — while staying at the 40pt tap-target floor.
const HEADER_SIZE = 40;

// The plate's radius, shared with the band capsule so the frame's object is the
// same shape wherever it appears.
const PLATE_RADIUS = 12;

export interface HomeKeyProps {
  onPress: () => void;
  variant: "floating" | "leave";
}

export default function HomeKey({
  onPress,
  variant,
}: HomeKeyProps): React.JSX.Element {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const styles = React.useMemo(() => makeStyles(colors), [colors]);

  // Leave: a bare plate the caller seats as the leading control of a header row.
  if (variant === "leave") {
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

  // Floating: an icon-only plate centered along the bottom edge. Centered (not
  // corner-anchored) so it reads as a deliberate "return to springboard"
  // affordance instead of a lone Android-style corner button.
  return (
    <View
      style={[styles.floatWrap, { paddingBottom: Math.max(insets.bottom, 10) }]}
      pointerEvents="box-none"
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Back to your apps"
        onPress={onPress}
        style={[styles.plate, styles.floatKey]}
      >
        <Icon name="Grid" size={22} color={colors.text} />
      </Pressable>
    </View>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    floatKey: {
      height: FLOAT_SIZE,
      width: FLOAT_SIZE,
    },
    floatWrap: {
      alignItems: "center",
      bottom: 0,
      left: 0,
      position: "absolute",
      right: 0,
    },
    headerKey: {
      height: HEADER_SIZE,
      width: HEADER_SIZE,
    },
    // Opaque paper on the frame's page colour, a hairline edge, a 12px radius.
    // Anything else here is glass creeping back.
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
