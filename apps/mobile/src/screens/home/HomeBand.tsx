// The bottom navigation band (the Binding Layer, invariant 1).
//
// One band, never themed by an app, never scrolled away, never a drawer. It
// carries the FRAME's destinations only — Home, pinned places, More — never the
// installed apps (./band, ./places).
//
// None of these is an app, so none earns a tinted identity chip: every tab is a
// bare ink mark over its label. If the shell spends no colour, every colour on
// screen belongs to an app. Tinted paper, not glass: no blur, no gloss, no drop
// shadow anywhere in this tree.
//
// NO ACTIVE BAR (:5176-5179): the label's held pair `band` (400) → `control`
// (600) plus full ink carries the whole state, and the inactive icon steps down
// to `textFaint`, not `textSoft`.
//
// Home-only chrome over the native-stack navigator, never
// `@react-navigation/bottom-tabs`: every app is a full-screen cover pushed FROM
// Home, not a sibling tab route, so there is no "current tab" to track — the
// band is off screen then, and Home is always active while it is up.

import * as Haptics from "expo-haptics";
import React, { useMemo } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import {
  BAND_BORDER,
  BAND_INSET,
  bandSurfaceStyle,
} from "../../kit/band-surface";
import Icon from "../../kit/components/Icon";
import { Text } from "../../kit/components/NativeText";
import { useReplica } from "../../kit/replica/ReplicaProvider";
import { borders, family, metrics, t, useTheme, radii } from "../../kit/theme";
import type { ThemeColors } from "../../kit/theme";
import { bandTabs } from "./band";
import type { BandTab, BandTarget } from "./band";
import { usePlacePins } from "./home-pins";
import { enabledPlacePins } from "./places";

export interface HomeBandProps {
  /** The tab the member is looking at. Always `home` while the band is up. */
  active: BandTarget;
  onSelect: (target: BandTarget) => void;
}

export default function HomeBand({
  active,
  onSelect,
}: HomeBandProps): React.JSX.Element {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const insets = useSafeAreaInsets();
  // Pinned places, never a static five: pinning is how a member changes what
  // shows up here.
  const pins = usePlacePins();
  // …minus the places this gateway does not serve. The capability answer is the
  // session's one `/info` read, never a probe from here. Invariant 1's cap
  // still applies to what is left.
  const { features } = useReplica();
  const tabs = useMemo(
    () => bandTabs(enabledPlacePins(pins, features)),
    [pins, features]
  );

  return (
    // The home-indicator inset lifts the FLOAT; it is never padding inside the
    // band, or this and a claimed band sit at different heights.
    <View style={[styles.wrap, { marginBottom: BAND_INSET + insets.bottom }]}>
      {tabs.map((tab) => (
        <Tab
          key={tab.id}
          tab={tab}
          active={tab.id === active}
          colors={colors}
          styles={styles}
          onPress={() => {
            void Haptics.selectionAsync();
            onSelect(tab.id);
          }}
        />
      ))}
      {/* More is not a place — it opens a sheet — so it draws the "···" glyph
          in a bordered square (:2575-2578), outside the loop above. */}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="All apps and places"
        onPress={() => {
          void Haptics.selectionAsync();
          onSelect("more");
        }}
        style={({ pressed }) => [styles.tab, pressed && styles.tabPressed]}
      >
        <View style={styles.moreGlyph}>
          <Text style={styles.moreGlyphMark}>···</Text>
        </View>
        <Text style={styles.moreLabel} numberOfLines={1}>
          More
        </Text>
      </Pressable>
    </View>
  );
}

function Tab({
  tab,
  active,
  colors,
  styles,
  onPress,
}: {
  tab: BandTab;
  active: boolean;
  colors: ThemeColors;
  styles: ReturnType<typeof makeStyles>;
  onPress: () => void;
}): React.JSX.Element {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={tab.name + (active ? ", current place" : "")}
      accessibilityState={{ selected: active }}
      onPress={onPress}
      style={({ pressed }) => [styles.tab, pressed && styles.tabPressed]}
    >
      <View style={styles.mark}>
        {/* Inactive is `textFaint`, one step fainter than the label's
            `textSoft` (:5164-5165) — never the label's token, and never a
            claimed band's app hue: this frame spends no colour. */}
        <Icon
          name={tab.icon}
          size={19}
          color={active ? colors.text : colors.textFaint}
        />
      </View>
      {/* Selection is the label's weight and colour, and nothing else. */}
      <Text
        style={[styles.label, active ? styles.labelActive : undefined]}
        numberOfLines={1}
      >
        {tab.short}
      </Text>
    </Pressable>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    label: {
      // The INACTIVE half of the ramp's held `band`/`control` pair — same
      // 11/15 rung, so a tap changes weight with the metrics pinned and the
      // band cannot reflow under a member's eye. NO `fontFamily` override
      // either way: the roles carry their own faces.
      ...t("band"),
      // `stretch` is what makes `numberOfLines={1}` ellipsize INSIDE the tab
      // (:5178). Without it the label's box is its intrinsic width, RN does not
      // clip, and long neighbouring labels run together as one word.
      alignSelf: "stretch",
      color: colors.textSoft,
      marginTop: 3,
      textAlign: "center",
    },
    labelActive: { ...t("control"), color: colors.text },
    // `glyph(30)` (:5156-5157, :5165), NOT the 26pt launcher-row glyph and not
    // a bare line box. The 19pt icon and the 30pt slot are two handoff numbers.
    mark: {
      alignItems: "center",
      borderRadius: radii.md,
      height: 30,
      justifyContent: "center",
      width: 30,
    },
    moreGlyph: {
      alignItems: "center",
      // Border only, in `lineStrong` (:5966-5967) — never the lighter `line`,
      // which is the handoff's `t.lineS`.
      borderColor: colors.lineStrong,
      borderRadius: radii.md,
      borderWidth: borders.hairline,
      height: 26,
      justifyContent: "center",
      width: 26,
    },
    moreGlyphMark: {
      color: colors.textSoft,
      fontFamily: family.sansMedium,
      fontSize: t("mono").fontSize,
    },
    moreLabel: {
      // More is never "current", so it holds the inactive half permanently.
      ...t("band"),
      alignSelf: "stretch",
      color: colors.textSoft,
      marginTop: 3,
      textAlign: "center",
    },
    tab: {
      alignItems: "center",
      flex: 1,
      justifyContent: "center",
      minHeight: metrics.row,
      // Belt to the label's braces (:5176): a tab cannot paint outside its own
      // sixth of the band.
      overflow: "hidden",
      // The gutter that makes long labels truncate rather than read as one
      // word. On the TAB, not the label, so the 44pt target is unchanged.
      paddingBottom: 3,
      paddingHorizontal: 4,
      paddingTop: 7,
    },
    tabPressed: { backgroundColor: colors.bgPress },
    wrap: {
      flexDirection: "row",
      paddingHorizontal: 4,
      // The band FLOATS — the same rectangle a claimed band draws (§G), never a
      // flush edge-to-edge bar, or the frame's band and Photos' band read as
      // different objects.
      //
      // Ground is `bgElev` (:5962-5963), NOT `bg`: Home's page is `bg`, and a
      // plate the colour of its page does not float. NOT `bgChrome` either —
      // its dark value sits BELOW the dark page and the band sinks in.
      // `lineStrong` at a full point is the handoff's `t.line`; our `line` is
      // its lighter `t.lineS`.
      ...bandSurfaceStyle(colors.bgElev, colors.lineStrong, BAND_BORDER),
    },
  });
