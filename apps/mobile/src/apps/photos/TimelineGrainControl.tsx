// THE LIBRARY'S GRAIN CONTROL — Years · Months · All (#712 iOS parity).
//
// PERMANENT — never armed by scroll and withdrawn 3.2 seconds after the last
// gesture. The defect that arrangement causes is worth stating plainly: the
// maintainer used
// this app against native iOS Photos and never discovered that Years and Months
// existed at all. The scroll-arming was defended as rent — 44 points of
// photographs for a control touched a few times a session — and the accounting
// was right about the cost and wrong about what was being bought. A control
// that is the ONLY path to a whole feature is not an accelerator whose rent can
// be haggled over; it is the feature's front door, and an invisible front door
// means the rooms behind it do not exist. Nothing here may be conditioned on
// activity: no timers, no arming, no opacity tied to scrolling. If the Library
// is on screen and there is a library to look at, this is on screen.
//
// It is drawn in the BAND'S OWN GRAMMAR, not a new one — the single thing the
// predecessor got right, kept verbatim: one opaque `bgElev` plate with a 1pt
// `lineStrong` edge and `BAND_RADIUS` corners, held `BAND_INSET` off the stage,
// with the active segment marked by the same 2pt ink rule across its top edge
// that both bands draw (`kit/band-surface.ts`). It floats directly above the
// band, so anything else would read as a second design system stacked on the
// first.
//
// NEVER GLASS OR BLUR, for the reason `PhotosBand.tsx` states about the band
// itself: this floats over unpredictable photographs, and label contrast and
// the active mark must not depend on what the member photographed. A white
// control over a white beach loses both.

import React, { useMemo } from "react";
import { Pressable, StyleSheet, View } from "react-native";

import {
  BAND_ACTIVE_RULE,
  BAND_ACTIVE_RULE_INSET,
  BAND_BORDER,
  BAND_INSET,
  BAND_RADIUS,
} from "../../kit/band-surface";
import { Text } from "../../kit/components/NativeText";
import { t, useTheme } from "../../kit/theme";
import type { ThemeColors } from "../../kit/theme";
import { GRAIN_LABELS, TIMELINE_GRAINS } from "./timeline-grains";
import type { TimelineGrain } from "./timeline-grains";

/** A segment's own minimum height — the coarse-pointer target floor. */
const SEGMENT_MIN_HEIGHT = 44;

/**
 * How much of the grid's foot this control permanently covers.
 *
 * Because it is permanent it now owes the grid a RESERVE, which its transient
 * predecessor did not: a floating plate that is always there would otherwise
 * sit on the last row of photographs forever, and "scroll a bit further" is not
 * an answer when there is nothing further to scroll to. Every surface that
 * mounts this control pads its scroll content by exactly this much.
 */
export const GRAIN_CONTROL_SLOT =
  SEGMENT_MIN_HEIGHT + 2 * BAND_BORDER + BAND_INSET;

export interface TimelineGrainControlProps {
  grain: TimelineGrain;
  onGrain: (grain: TimelineGrain) => void;
}

export default function TimelineGrainControl({
  grain,
  onGrain,
}: TimelineGrainControlProps): React.JSX.Element {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);

  return (
    // The DOCK is a full-width strip and must stay transparent to touch
    // everywhere the plate is not — `box-none` passes its own presses through
    // to the grid while leaving the plate's segments pressable. It is set in
    // STYLE, not as the legacy prop: on the New Architecture the prop form is
    // the deprecated spelling, and mixing the two is how a control ends up
    // visible and untappable.
    <View style={styles.dock}>
      <View style={styles.plate} accessibilityRole="tablist">
        {TIMELINE_GRAINS.map((key) => {
          const active = key === grain;
          return (
            <Pressable
              key={key}
              accessibilityRole="tab"
              accessibilityLabel={GRAIN_LABELS[key]}
              accessibilityState={{ selected: active }}
              onPress={() => onGrain(key)}
              style={styles.segment}
            >
              <View
                style={[
                  styles.activeRule,
                  active ? { backgroundColor: colors.text } : styles.ruleHidden,
                ]}
              />
              <Text
                numberOfLines={1}
                style={[styles.label, active ? styles.labelActive : undefined]}
              >
                {GRAIN_LABELS[key]}
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
      height: BAND_ACTIVE_RULE,
      insetInlineEnd: BAND_ACTIVE_RULE_INSET,
      insetInlineStart: BAND_ACTIVE_RULE_INSET,
      position: "absolute",
      top: 0,
    },
    dock: {
      alignItems: "center",
      bottom: 0,
      insetInlineEnd: 0,
      insetInlineStart: 0,
      // The control floats INSIDE the grid's own slot, which already ends above
      // the band (the band is a flex sibling, not an overlay) — so the only
      // clearance it needs is the band's own inset, not the band's height.
      paddingBottom: BAND_INSET,
      pointerEvents: "box-none",
      position: "absolute",
      // ABOVE THE GRID FOR TOUCH, not just for paint. The grid underneath is
      // wrapped in a `GestureDetector` whose tap gesture spans the whole slot
      // (`PhotoTimeline.tsx`), and a gesture-handler recogniser does not lose
      // to a plain sibling drawn after it — without this, every press on a
      // segment fell through and opened the photograph beneath the control.
      zIndex: 2,
    },
    label: { ...t("control"), color: colors.textSoft },
    labelActive: { color: colors.text },
    plate: {
      backgroundColor: colors.bgElev,
      borderColor: colors.lineStrong,
      borderRadius: BAND_RADIUS,
      borderWidth: BAND_BORDER,
      flexDirection: "row",
      gap: 2,
      overflow: "hidden",
      paddingHorizontal: 2,
    },
    ruleHidden: { backgroundColor: "transparent" },
    segment: {
      alignItems: "center",
      justifyContent: "center",
      minHeight: SEGMENT_MIN_HEIGHT,
      paddingHorizontal: 18,
    },
  });
