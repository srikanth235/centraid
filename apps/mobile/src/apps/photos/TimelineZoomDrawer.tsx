// The Library's zoom drawer — Years · Months · All (issue #712 iOS parity).
//
// It appears when the member starts scrolling and withdraws once they stop,
// which is the whole reason it can afford to overlay the grid: a permanent row
// here would cost 44pt of photographs for a control touched a few times a
// session, and that is the same rent argument that moved the tile-size stepper
// off the toolbar and into the header menu (`photos-library-menu.ts`).
//
// It is drawn in the BAND'S OWN GRAMMAR, not a new one: one opaque `bgElev`
// plate with a 1pt `lineStrong` edge and `BAND_RADIUS` corners, held `BAND_INSET`
// off the stage, with the active segment marked by the same 2pt ink rule across
// its top edge that `PhotosBand.tsx` draws. It sits directly above the band, so
// anything else would read as a second design system stacked on the first. Never
// glass or blur, for the reason the band states: this floats over unpredictable
// photographs, and label contrast must not depend on what the member shot.
//
// It STAYS UP at the Years and Months grains. There, it is not an accelerator —
// it is the only way back to All that is not a card tap, and a control that is
// the sole exit may not hide itself.

import React, { useEffect, useMemo, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";

import { BAND_BORDER, BAND_INSET, BAND_RADIUS } from "../../kit/band-surface";
import { Text } from "../../kit/components/NativeText";
import { t, useTheme } from "../../kit/theme";
import type { ThemeColors } from "../../kit/theme";
import { ZOOM_LABELS, ZOOM_LEVELS } from "./photos-zoom";
import type { TimelineZoom } from "./photos-zoom";

/** How long the drawer stays up after the last scroll gesture.
 *
 * Measured against what a member actually does, not against how long the
 * gesture took: they flick, the grid settles, they READ where they landed, and
 * only then decide to jump a year. Two seconds expires during the reading, so
 * the control is gone at the moment it is wanted. Three and a bit outlasts that
 * pause while still being plainly temporary. */
const HIDE_AFTER_MS = 3200;
/** The active-segment mark, matching the band's tab rule exactly. */
const ACTIVE_RULE = 2;
const ACTIVE_RULE_INSET = 14;

export interface TimelineZoomDrawerProps {
  level: TimelineZoom;
  onLevel: (level: TimelineZoom) => void;
  /** Bumped by the grid on every scroll gesture. A COUNTER rather than a
   *  boolean: two drags in a row must re-arm the hide timer, and a boolean that
   *  is already `true` produces no effect run to re-arm it with. */
  activity: number;
}

export default function TimelineZoomDrawer({
  level,
  onLevel,
  activity,
}: TimelineZoomDrawerProps): React.JSX.Element | null {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    // A CHANGE OF GRAIN counts as activity too, not just a scroll. Landing on
    // All from a Months card is an arrival the member did not scroll to, and
    // without this the drawer would vanish the instant they got there —
    // taking away the only way back up a grain until they scrolled the grid
    // for no reason but to summon it.
    if (activity === 0 && level === "all") return undefined;
    // Deferred out of the effect body: a synchronous `setState` there is the
    // shape react-compiler rejects, and the microtask lands in the same frame.
    queueMicrotask(() => setScrolled(true));
    const timer = setTimeout(() => setScrolled(false), HIDE_AFTER_MS);
    return () => clearTimeout(timer);
  }, [activity, level]);

  // At a summary grain the drawer is the only way back — see the header.
  if (!scrolled && level === "all") return null;

  return (
    // The DOCK is a full-width strip and must stay transparent to touch
    // everywhere the plate is not — `box-none` passes its own presses through
    // to the grid while leaving the plate's segments pressable. It is set in
    // STYLE, not as the legacy prop: on the New Architecture the prop form is
    // the deprecated spelling, and mixing the two is how a control ends up
    // visible and untappable.
    <View style={styles.dock}>
      <View style={styles.plate} accessibilityRole="tablist">
        {ZOOM_LEVELS.map((key) => {
          const active = key === level;
          return (
            <Pressable
              key={key}
              accessibilityRole="tab"
              accessibilityLabel={ZOOM_LABELS[key]}
              accessibilityState={{ selected: active }}
              onPress={() => onLevel(key)}
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
                {ZOOM_LABELS[key]}
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
      height: ACTIVE_RULE,
      insetInlineEnd: ACTIVE_RULE_INSET,
      insetInlineStart: ACTIVE_RULE_INSET,
      position: "absolute",
      top: 0,
    },
    dock: {
      alignItems: "center",
      bottom: 0,
      insetInlineEnd: 0,
      insetInlineStart: 0,
      // The drawer floats INSIDE the grid's own slot, which already ends above
      // the band (the band is a flex sibling, not an overlay) — so the only
      // clearance it needs is the band's own inset, not the band's height.
      paddingBottom: BAND_INSET,
      pointerEvents: "box-none",
      position: "absolute",
      // ABOVE THE GRID FOR TOUCH, not just for paint. The grid underneath is
      // wrapped in a `GestureDetector` whose tap gesture spans the whole slot
      // (`PhotoTimeline.tsx`), and a gesture-handler recogniser does not lose
      // to a plain sibling drawn after it — without this, every press on a
      // segment fell through and opened the photograph beneath the drawer.
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
      minHeight: 44,
      paddingHorizontal: 18,
    },
  });
