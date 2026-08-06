// The bottom navigation band (the Binding Layer, invariant 1).
//
// One band, never themed by an app, never scrolled away, never a drawer. What
// changed with the v4 Home is WHAT IT CARRIES: the frame's own destinations —
// Home plus up to four of the member's pinned places, plus More — and never
// the installed apps, which live on Home's springboard and in All apps. See
// ./band for why, and ./places for the eleven-row table the pins come from.
//
// Because none of these is an app, none of them earns a tinted identity chip:
// every tab is a bare ink mark over its label. That is the invariant working —
// if the shell spends no colour, every colour on screen belongs to an app.
//
// No active bar, either (handoff :5176-5179 — the compact band's `bandLabelCss`
// carries the whole state: weight 500 + full ink when active, weight 400 +
// the softer `textSoft` when not, and the icon itself steps down to the
// faintest `textFaint` rather than `textSoft`). The desktop launcher still
// draws a 2px ink bar for its row-shaped rows; the compact band never did,
// and this used to draw one anyway, which is the bug this fixes.
//
// The metaphor is tinted paper, not glass: no blur, no gloss, no drop shadow.
// That is not this band's local preference — the handoff draws no blur and no
// soft shadow on any product surface, so there is no glass idiom left in the
// tree to reach for.
//
// Home-only chrome, styled over the existing native-stack navigator rather than
// a `@react-navigation/bottom-tabs` bar: every app in this springboard model is
// a full-screen cover pushed FROM Home (App.tsx's COVER_OPTIONS), not a sibling
// tab route, so there is no "current tab" to track once a cover is open — the
// band simply isn't on screen then, and Home is always the active tab while it
// is.

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
import { borders, family, metrics, useTheme } from "../../kit/theme";
import type { ThemeColors } from "../../kit/theme";
import { bandTabs } from "./band";
import type { BandTab, BandTarget } from "./band";
import { usePlacePins } from "./home-pins";

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
  // The band's own destinations are Home plus the member's pinned places
  // (./places, via ./home-pins) — never a static five, now that pinning a
  // place is how a member changes what shows up here.
  const pins = usePlacePins();
  const tabs = useMemo(() => bandTabs(pins), [pins]);

  return (
    // The home-indicator inset lifts the FLOAT, it is not padding inside the
    // band — same as a claimed band (PhotosBand), so the two sit at the same
    // height off the bottom of the screen.
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
      {/* More is not a place — it opens the All-apps sheet — so it draws the
          handoff's own "···" glyph in a bordered square rather than an app
          icon (:2575-2578), outside the place loop above. */}
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
        {/* Icon inactive is `textFaint` — one step fainter than the label's
            `textSoft` (handoff :5164-5165 / :5178) — never the same token as
            the label, and never the same active colour as a claimed band's
            app-hued icon: this frame spends no colour of its own. */}
        <Icon
          name={tab.icon}
          size={19}
          color={active ? colors.text : colors.textFaint}
        />
      </View>
      {/* Selection is carried by the label's own weight and colour — 500 +
          full ink when active, 400 + `textSoft` when not — and nothing else.
          The compact band draws no active bar (see the file header). */}
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
      // `stretch` is what makes `numberOfLines={1}` ellipsize INSIDE the tab
      // (handoff :5178 — `width:100%;min-width:0;text-overflow:ellipsis`).
      // Without it the label's box is its intrinsic width, a React Native view
      // does not clip by default, and a long name simply ran into its
      // neighbour: "Connectors" and "Analytics" sat with no gap between them.
      // The handoff truncates to "Connect…" for exactly this reason.
      alignSelf: "stretch",
      color: colors.textSoft,
      fontFamily: family.sansRegular,
      fontSize: 11,
      lineHeight: 14,
      marginTop: 3,
      textAlign: "center",
    },
    labelActive: { color: colors.text, fontFamily: family.sansMedium },
    // The handoff's band icon sits in `glyph(30)` — a 30×30 square with
    // `border-radius: round(30 * 0.26) = 8` (:5156-5157, :5165), NOT the 26pt
    // launcher-row glyph and not a bare 24-tall line box. The wrap is what
    // reserves the icon's slot, so a 19pt icon and a 30pt slot are two numbers,
    // both from the handoff.
    mark: {
      alignItems: "center",
      borderRadius: 8,
      height: 30,
      justifyContent: "center",
      width: 30,
    },
    moreGlyph: {
      alignItems: "center",
      // No fill — border only (handoff :5966's `moreGlyphCss`), and the edge is
      // `t.line` = this ramp's `lineStrong` (:5967), never the lighter `line`
      // (which is the handoff's `t.lineS`).
      borderColor: colors.lineStrong,
      borderRadius: 7,
      borderWidth: borders.hairline,
      height: 26,
      justifyContent: "center",
      width: 26,
    },
    moreGlyphMark: {
      color: colors.textSoft,
      fontFamily: family.sansMedium,
      fontSize: 12,
    },
    moreLabel: {
      alignSelf: "stretch",
      color: colors.textSoft,
      fontFamily: family.sansRegular,
      fontSize: 11,
      lineHeight: 14,
      marginTop: 3,
      textAlign: "center",
    },
    tab: {
      alignItems: "center",
      flex: 1,
      justifyContent: "center",
      minHeight: metrics.row,
      // Belt to the label's braces (handoff :5176 — the band button carries
      // `min-width:0;overflow:hidden`): whatever a tab holds, it cannot paint
      // outside its own sixth of the band.
      overflow: "hidden",
      // The gutter. Without it two long labels ("Connectors", "Analytics")
      // ended flush against each other and read as one word; with it they
      // truncate instead, which is what the handoff shows ("Connect…"). The
      // gutter is on the TAB, not the label, so the 44pt touch target is
      // unchanged — only the text is narrowed.
      paddingBottom: 3,
      paddingHorizontal: 4,
      paddingTop: 7,
    },
    tabPressed: { backgroundColor: colors.bgPress },
    wrap: {
      flexDirection: "row",
      paddingHorizontal: 4,
      // The band FLOATS — the same rectangle a claimed band draws (§G): inset
      // from all three edges, 12 radius, hairline all round, opaque paper. It
      // used to be a flush edge-to-edge bar with only a top rule, which made
      // the frame's band and Photos' band visibly different objects.
      //
      // The ground is `bgElev` — the handoff's `t.surf` (:5962-5963) — NOT
      // `bg`. Home's page is `bg`, so a `bg` band was a white plate on a white
      // page: the float was carried by a hairline and nothing else, and on
      // device the band did not read as an object at all. A step away from the
      // page is what makes a floating plate float. `bgChrome` shares `bgElev`'s
      // LIGHT value (#F5F4F2) so it looked right, but its dark value is a step
      // BELOW the dark page — the band sank into the page in dark mode.
      // `lineStrong` at a full point: the handoff's band draws `1px solid
      // t.line`, and `t.line` is this ramp's `lineStrong` (#E5E4E1) — `t.lineS`
      // is our `line`. This carried the lighter token at a third the width.
      ...bandSurfaceStyle(colors.bgElev, colors.lineStrong, BAND_BORDER),
    },
  });
