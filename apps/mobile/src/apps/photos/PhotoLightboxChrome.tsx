// THE STAGE'S CHROME. `PhotoLightbox` owns all viewer STATE; everything here is
// a pure view over values it has already decided.
//
// THERE IS NO TOP BAR — a full-width strip is a second ground charging the stage
// its own height on every screen. The head carries three FLOATING elements the
// stage runs under: a back chevron (`chevron-left`, not `✕`: this viewer is
// pushed on a stack and returns to its grid), the centred capture stamp (not a
// control, which is why it sits where nobody scans for one), and the trailing
// `···` or the slideshow's one labelled way out.
//
// NO TAP-TO-TOGGLE: a tap that hides every control hides its own way back, so
// the gesture would be the only route to the state it made (§15).
//
// EVERY ELEMENT IS ON THE STAGE, AND THAT IS A TOKEN RULE, NOT A LOOK: ink from
// `--on-stage`/`--on-stage-soft`, hairlines from `--stage-line`, plates on
// `--stage-sunken` — a page token lands at 2.85:1 in light mode. Plates are
// OPAQUE, never glass: a translucent plate makes contrast a property of what the
// member photographed, which is why this app carries no blur. That shared
// constraint is why these pieces live in one module.

import React from "react";
import { Pressable, View } from "react-native";
import type { View as RNView } from "react-native";
import type { EdgeInsets } from "react-native-safe-area-context";

import Icon from "../../kit/components/Icon";
import { Text } from "../../kit/components/NativeText";
import type { ThemeColors } from "../../kit/theme";
import { styles } from "./PhotoLightbox.styles";
import { SLIDESHOW_ACTION, VIEWER_CHROME_INSET } from "./viewer-model";

/**
 * ONE shape for chip and capsule alike: two styles would be two chances for the
 * edge, ground or radius to drift. `forwardRef`'d because `useMenuAnchor`'s
 * `measureInWindow` needs the native node of the `···` plate.
 */
export const ViewerChromePlate = React.forwardRef<
  RNView,
  { colors: ThemeColors; children: React.ReactNode }
>(({ colors, children }, ref) => (
  <View
    ref={ref}
    style={[
      styles.chromePlate,
      { backgroundColor: colors.stageSunken, borderColor: colors.stageLine },
    ]}
  >
    {children}
  </View>
));
ViewerChromePlate.displayName = "ViewerChromePlate";

/**
 * Icon-only is allowed ONLY because `label` is still the accessible name, read
 * from the same field a visible label would be (WCAG 4.1.2). A label carrying a
 * REASON rather than a name stays on screen instead.
 */
export function ViewerChromeTarget({
  colors,
  icon,
  label,
  disabled,
  hint,
  selected,
  tone,
  /** 56 inside a capsule — neighbours at 44 is where mis-taps start. A lone
   *  chip IS its plate, so it takes the 44 floor. */
  wide,
  onPress,
}: {
  colors: ThemeColors;
  icon: string;
  label: string;
  disabled?: boolean;
  hint?: string;
  selected?: boolean;
  tone?: "ink" | "net";
  wide?: boolean;
  onPress: () => void;
}): React.JSX.Element {
  // `--on-stage-soft`, NOT `--text-disabled`: the page ramp's disabled ink is
  // mixed against paper and vanishes here, so the control would read as absent
  // rather than refused.
  const ink = disabled
    ? colors.onStageSoft
    : tone === "net" || selected === true
      ? colors.net
      : colors.onStage;
  return (
    <Pressable
      accessibilityHint={disabled ? hint : undefined}
      accessibilityLabel={label}
      accessibilityRole="button"
      accessibilityState={{ disabled: Boolean(disabled), selected }}
      disabled={disabled}
      onPress={onPress}
      style={[styles.chromeTarget, wide ? styles.chromeTargetWide : null]}
    >
      <Icon name={icon} size={23} color={ink} />
    </Pressable>
  );
}

/** `box-none`, so the photograph keeps every touch that misses a plate: a
 *  transparent row swallowing the swipe costs the pager a strip of screen. */
export function ViewerTopChrome({
  colors,
  insets,
  /** The capture date, the photograph's name when there is no capture time, or
   *  the mode's title. */
  title,
  /** The clock and place, the editor's live sentence, or the show's position. */
  meta,
  /** Never drawn: the stamp's accessible name, so a screen reader still hears
   *  the caption the eye now reads as a date. */
  name,
  editing,
  slideshow,
  onClose,
  onLeaveSlideshow,
  onOverflow,
  overflowRef,
}: {
  colors: ThemeColors;
  insets: EdgeInsets;
  title: string;
  meta: string;
  name: string;
  editing: boolean;
  slideshow: boolean;
  onClose: () => void;
  onLeaveSlideshow: () => void;
  onOverflow: () => void;
  /** Measured on the press that opens the anchored menu (`useMenuAnchor`). */
  overflowRef?: React.RefObject<RNView | null>;
}): React.JSX.Element {
  return (
    <View
      pointerEvents="box-none"
      style={[
        styles.chromeTop,
        { paddingTop: insets.top + VIEWER_CHROME_INSET },
      ]}
    >
      <ViewerChromePlate colors={colors}>
        <ViewerChromeTarget
          colors={colors}
          icon="chevron-left"
          label="Back to the photographs"
          onPress={onClose}
        />
      </ViewerChromePlate>

      <ViewerChromePlate colors={colors}>
        <View
          accessible
          accessibilityLabel={stampName(name, title, meta)}
          style={styles.chromeStamp}
        >
          <Text
            numberOfLines={1}
            style={[styles.chromeStampDate, { color: colors.onStage }]}
          >
            {title}
          </Text>
          {/* `--on-stage-soft`, never `--text-soft` — see the header. */}
          {meta ? (
            <Text
              numberOfLines={1}
              style={[styles.chromeStampTime, { color: colors.onStageSoft }]}
            >
              {meta}
            </Text>
          ) : null}
        </View>
      </ViewerChromePlate>

      {/* LABELLED, never a pause glyph over a press that exits: label and
          effect both read from `SLIDESHOW_ACTION` so they cannot drift. The
          editor suppresses this slot but keeps its width, or the stamp slides
          off centre between modes. */}
      {editing ? (
        <View style={styles.chromeSpacer} />
      ) : slideshow ? (
        <ViewerChromePlate colors={colors}>
          <Pressable
            accessibilityLabel={SLIDESHOW_ACTION.label}
            accessibilityRole="button"
            onPress={() => {
              if (SLIDESHOW_ACTION.effect === "leave") onLeaveSlideshow();
            }}
            style={styles.chromeTextTarget}
          >
            <Text style={[styles.statusAction, { color: colors.onStage }]}>
              {SLIDESHOW_ACTION.label}
            </Text>
          </Pressable>
        </ViewerChromePlate>
      ) : (
        <ViewerChromePlate colors={colors} ref={overflowRef}>
          <ViewerChromeTarget
            colors={colors}
            icon="more-horizontal"
            label="More actions"
            onPress={onOverflow}
          />
        </ViewerChromePlate>
      )}
    </View>
  );
}

/** The name is dropped when it IS the first line: a screen reader saying it
 *  twice is a stutter, not emphasis. */
function stampName(name: string, title: string, meta: string): string {
  return [name, title === name ? "" : title, meta].filter(Boolean).join(" · ");
}

/** One status line inside the stage — no toast, no spinner. While the editor is
 *  open it carries that mode's live promise instead. */
export function ViewerStatusLine({
  colors,
  text,
  actionLabel,
  onAction,
}: {
  colors: ThemeColors;
  text: string;
  /** The ONE offer to spend the bytes, or null: two controls for one fetch is
   *  two states to keep in step. */
  actionLabel: string | null;
  onAction: () => void;
}): React.JSX.Element {
  return (
    <View style={[styles.statusLine, { borderTopColor: colors.stageLine }]}>
      <Text
        numberOfLines={2}
        style={[styles.statusText, { color: colors.onStageSoft }]}
      >
        {text}
      </Text>
      {actionLabel ? (
        <Pressable
          accessibilityLabel={actionLabel}
          accessibilityRole="button"
          hitSlop={10}
          onPress={onAction}
        >
          <Text style={[styles.statusAction, { color: colors.link }]}>
            {actionLabel}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}
