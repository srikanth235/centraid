// The phone's bottom band, rendered (Photos v4 handoff §3.1, CHANGELOG §F/§G).
//
// Opaque paper, never glass — which is now simply what the whole app is, so
// this file no longer has to argue the case. The blur idiom is gone from the
// tree entirely (`GlassBar` deleted, `expo-blur` dropped); the handoff carries
// no `backdrop-filter`, no `blur()` and no soft shadow on any product surface.
//
// The reason survives the component that used to violate it: this bar sits over
// unpredictable photographs, so label contrast, the 2px ink active mark and the
// focus ring must not depend on what the member photographed — a white bar over
// a white beach loses all three — and `prefers-reduced-transparency` would need
// the opaque bar anyway.
//
// Content ends ABOVE this band rather than running under it. That costs the
// band's own height of grid and buys a bar legible on every photograph — and
// it is LAYOUT, not padding: the band is a `flex:none` sibling below the scroll
// region (:4955), so the viewport is genuinely shorter. A reserve padded onto
// the scroll content instead only clears the END of it; mid-scroll a day header
// and a tile caption still passed underneath.
//
// ANATOMY (handoff :4955-4975). The claimed band is TWO PLATES in a TRANSPARENT
// row, not one plate with a capsule inside it:
//
//   row      transparent; row; align-items:stretch; gap 8; padding 8 / 12 / 12
//   ├─ capsule  flex:none; 52 wide; radius 12; 1pt lineStrong; ground = the
//   │           FRAME's neutral page (`colors.bg`), never Photos' mat
//   └─ group    flex:1; radius 12; 1pt lineStrong; ground `bgElev` (t.surf);
//               padding 0 2; gap 2 — and the four tabs inside it
//
// The frame's own band (`screens/home/HomeBand`) is ONE plate of the same
// rectangle. What the two share — radius, edge, ground, inset — is stated once
// in `kit/band-surface.ts`; what differs is only how many plates carry it.

import React, { useMemo } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import {
  BAND_BORDER,
  BAND_HEIGHT,
  BAND_INSET,
  BAND_RADIUS,
  BAND_TAB_MIN_HEIGHT,
  BAND_TOP_GAP,
} from "../../kit/band-surface";
import type { BandOwner } from "../../kit/band/band-owner";
import Icon from "../../kit/components/Icon";
import { Text } from "../../kit/components/NativeText";
import { family, useTheme } from "../../kit/theme";
import type { ThemeColors } from "../../kit/theme";
import { BAND_CAPSULE, resolveBand } from "./photos-band";
import type { BandDestinationKey } from "./photos-band";

/** The GROUP PLATE's inner gutter (:4959 — `padding:0 2px`, `gap:2px`). The 2pt
 *  the capsule used to carry as a `marginStart` lives here instead. */
const GROUP_GUTTER = 2;
/** The gap between the two plates (:4955 — `gap: R.gap.s`). */
const PLATE_GAP = 8;
/** The active destination is carried by a 2px ink rule across the tab's top
 *  edge (:4974) — the same mark the desktop shelf strip uses, so "where am I"
 *  reads identically on both. */
const ACTIVE_RULE = 2;
/** How far the active rule is held off each side of its tab (:4974 —
 *  `inset-inline:14px`). */
const ACTIVE_RULE_INSET = 14;

export interface PhotosBandProps {
  owner: BandOwner;
  current: BandDestinationKey;
  onSelect: (key: BandDestinationKey) => void;
  /** The capsule's one tap: All apps and places, in one move. */
  onHome: () => void;
}

/**
 * Renders the band Photos has claimed. When the member has handed the band
 * back (`owner === "host"`, from frame Settings) the app's TAB GROUP goes and
 * the frame's capsule stays — exactly one band exists at any moment, never
 * two, and the way home is never one of the things that disappears.
 */
export default function PhotosBand({
  owner,
  current,
  onSelect,
  onHome,
}: PhotosBandProps): React.JSX.Element | null {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const band = resolveBand(owner);
  if (band.owner !== "app") {
    // HANDED BACK, BUT NOT STRANDED (issue #712 E3). This used to `return
    // null` outright, on the premise that "the frame's own band takes over" —
    // true on web, where the shell renders its stem band underneath, and false
    // on the phone, where the frame's band lives on Home and a Photos stack
    // screen has none. Rendering nothing left the member inside Photos with no
    // way out but the OS back gesture, and §3.1 says the way home is the one
    // thing an app may never take away. So the capsule stays: the app's tab
    // group is what the member handed back, not the frame's control.
    return (
      <View
        style={[styles.band, { paddingBottom: BAND_INSET + insets.bottom }]}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={BAND_CAPSULE.label}
          onPress={onHome}
          style={[styles.capsule, { width: BAND_CAPSULE.size }]}
        >
          <Icon name={BAND_CAPSULE.icon} size={19} color={colors.textSoft} />
        </Pressable>
      </View>
    );
  }

  const { capsule } = band;
  return (
    // The claimed band is a TRANSPARENT row carrying TWO plates (:4955-4956).
    // It is not itself a plate: it has no ground, no edge and no radius, and it
    // carries no `accessibilityRole` either — a tablist here would nest the
    // frame's capsule inside the app's tab group and undo the very group
    // boundary the two plates exist to draw. The group below keeps the role.
    <View
      style={[
        styles.band,
        // The home-indicator inset lifts the FLOAT. It was a margin when the
        // band was one plate; now that the 12pt bottom inset is the container's
        // own padding, the lift goes there too — same total distance off the
        // bottom of the screen, same as HomeBand.
        { paddingBottom: BAND_INSET + insets.bottom },
      ]}
    >
      {/* Plate one: the capsule. A FRAME control on the FRAME's neutral page
          colour (`phostBg()` at :4963 — never Photos' mat, which is what made
          it read as part of the app), its own 12 radius and its own hairline.
          It stretches to the row's height rather than being square: the row is
          `align-items:stretch`, so both plates are exactly as tall as the tab
          group's tallest tab and their edges line up. */}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={capsule.label}
        onPress={onHome}
        style={[styles.capsule, { width: capsule.size }]}
      >
        <Icon name={capsule.icon} size={19} color={colors.textSoft} />
      </Pressable>

      {/* Plate two: the app's four destinations, as ONE group on its own
          `t.surf` ground (:4959-4960). The capsule is not in it — the gap
          between the two plates IS the seam, and it is the whole explanation
          for why Home is not a sixth tab. */}
      <View style={styles.group} accessibilityRole="tablist">
        {band.destinations.map((destination) => {
          const active = destination.key === current;
          return (
            <Pressable
              key={destination.key}
              accessibilityRole="tab"
              accessibilityLabel={destination.label}
              accessibilityState={{ selected: active }}
              onPress={() => onSelect(destination.key)}
              style={styles.tab}
            >
              {/* State is a mark on the leaf, never a container opacity. The
                  handoff draws it ABSOLUTE across the tab's top edge
                  (:4974 — `position:absolute;top:0;inset-inline:14px;height:2px`),
                  so it is a rule on the plate's edge rather than a pill in the
                  column: in flow it stole 2pt + a margin from the icon and
                  label, and a rounded 22pt stub read as a pill, not a rule.
                  `insetInline{Start,End}` — the legacy `start:`/`end:` props
                  do nothing on the New Architecture. */}
              <View
                style={[
                  styles.activeRule,
                  active ? { backgroundColor: colors.text } : styles.ruleHidden,
                ]}
              />
              <Icon
                name={destination.icon}
                size={20}
                color={active ? colors.text : colors.textSoft}
              />
              <Text
                numberOfLines={1}
                style={[styles.label, active ? styles.labelActive : undefined]}
              >
                {destination.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    activeRule: {
      // A rule, not a pill: square ends, full 2pt height, held 14pt off each
      // side of the tab, on the tab's top edge (:4974).
      borderRadius: 0,
      height: ACTIVE_RULE,
      insetInlineEnd: ACTIVE_RULE_INSET,
      insetInlineStart: ACTIVE_RULE_INSET,
      position: "absolute",
      top: 0,
    },
    band: {
      // TRANSPARENT (:4956). The band's grounds live on the two plates below;
      // this row only positions them. It used to be a plate itself — one
      // rectangle with the capsule floating inside it — which is a shape the
      // handoff never draws.
      alignItems: "stretch",
      backgroundColor: "transparent",
      flexDirection: "row",
      gap: PLATE_GAP,
      minHeight: BAND_HEIGHT,
      // The inset is the container's PADDING here, not either plate's margin:
      // `padding:8px 12px 12px` (:4955-4956). `paddingBottom` is applied at the
      // call site, where the home-indicator inset is added to it.
      paddingHorizontal: BAND_INSET,
      paddingTop: BAND_TOP_GAP,
    },
    capsule: {
      alignItems: "center",
      // The FRAME's neutral page colour (:4963's `phostBg()`), never Photos'
      // mat and never the app's paper: the capsule is the frame's control
      // sitting inside the app's band, and its ground is the one thing that
      // says so. It used to wear `toneMat` on a `bg` band — the two colours
      // swapped, which made the capsule read as the app's and the band as the
      // frame's, the opposite of the truth.
      backgroundColor: colors.bg,
      borderColor: colors.lineStrong,
      borderRadius: BAND_RADIUS,
      borderWidth: BAND_BORDER,
      justifyContent: "center",
    },
    group: {
      alignItems: "stretch",
      // The app's plate: `t.surf`, its own hairline and its own 12 radius
      // (:4959-4960).
      backgroundColor: colors.bgElev,
      borderColor: colors.lineStrong,
      borderRadius: BAND_RADIUS,
      borderWidth: BAND_BORDER,
      flex: 1,
      flexDirection: "row",
      gap: GROUP_GUTTER,
      paddingHorizontal: GROUP_GUTTER,
    },
    // 11px, 400 → 500 when active (:4975) — the same pair HomeBand's label
    // draws, because the frame's band and a claimed band say "you are here" the
    // same way. This used to be the `control` role (13px/500 always), which
    // both oversized the band and left the weight carrying no state.
    label: {
      alignSelf: "stretch",
      color: colors.textSoft,
      fontFamily: family.sansRegular,
      fontSize: 11,
      lineHeight: 14,
      textAlign: "center",
    },
    labelActive: { color: colors.text, fontFamily: family.sansMedium },
    ruleHidden: { backgroundColor: "transparent" },
    tab: {
      alignItems: "center",
      flex: 1,
      // `gap:2px` and NO vertical padding (:4970-4972) — the 52pt floor is what
      // makes the target, so padding on top of it only made the plate taller.
      gap: GROUP_GUTTER,
      justifyContent: "center",
      minHeight: BAND_TAB_MIN_HEIGHT,
      // Whatever a tab holds, it cannot paint outside its own fifth of the
      // plate (:4970's `min-width:0`).
      minWidth: 0,
    },
  });
