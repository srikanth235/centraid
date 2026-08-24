// THE STAGE'S CHROME (issue #712 P18, extracted from ./PhotoLightbox).
//
// THE SEAM. `PhotoLightbox` owns the viewer's STATE — which photograph, which
// mode (viewing / editing / slideshow), what the last write did, whether the
// full-quality bytes have been unlocked. The chrome that frames the stage owns
// none of it: what floats above the photograph and the status line below it are
// pure views over values the screen has already decided. Pulling them out is
// what makes that division visible rather than merely true, and it is the seam a
// future viewer engine claims — the same shapes on every media surface.
//
// ANATOMY: THERE IS NO TOP BAR. A 52px full-width strip is a second ground laid
// over the photograph, and it charges the stage its own height on every screen
// whether or not there is anything to say. The head of the stage carries
// THREE FLOATING ELEMENTS standing on it (`VIEWER_TOP_CHROME`):
//
//   chip     round, leading — a back chevron. It is `chevron-left`, not `✕`,
//            because this viewer is pushed onto a stack and pressing it RETURNS
//            to the grid the photograph was opened from; `✕` promises a thing
//            that closes over nothing, which is what a modal does. The
//            swipe-down still dismisses, and now the mark agrees with the swipe
//            as well as with the effect.
//   stamp    centred capsule, WHEN over WHEN-and-WHERE. Not a control, which is
//            why it sits in the middle: a member scanning for something to press
//            skips the centre. See `captureStamp` for why the date outranks the
//            caption — the caption is this element's ACCESSIBLE NAME, and its
//            editable home is the info sheet's Caption row.
//   chip     round, trailing — the `···` overflow, or the slideshow's one
//            labelled way out.
//
// The stage runs UNDER all three. That is the point of floating: the photograph
// is the screen, and the controls are things standing on it.
//
// NO TAP-TO-TOGGLE. Hiding the chrome on a tap is tempting and is deliberately
// not here: a tap that hides every control also hides its own way back, so the
// gesture would be the only route to the state it created — exactly what §15
// forbids, and what `GESTURE_POINTER_EQUIVALENTS` exists to make impossible to
// merge by accident.
//
// EVERY ELEMENT HERE IS ON THE STAGE, AND THAT IS A TOKEN RULE, NOT A LOOK. The
// stage is one colour in BOTH themes, so ink comes from `--on-stage` /
// `--on-stage-soft` and hairlines from `--stage-line`. A page token would land
// at 2.85:1 in light mode. The plates the chips and capsules stand on take
// `--stage-sunken`, the stage ramp's own second rung, edged in `--stage-line`:
// an OPAQUE plate, never glass. The reason is the one `PhotosBand` states — a
// translucent plate over an unpredictable photograph makes contrast a property
// of what the member photographed — and it is why this app carries no blur.
// That constraint is why these pieces live together in one module instead of one
// file each: they are the only ones that must be read against the stage, and the
// rule is stated once here.

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
 * The plate every floating element stands on. One shape for both: a chip is
 * simply a plate whose only child is one square target, so `radii.pill` rounds
 * it to a circle, and a capsule is the same plate grown by its contents. Two
 * styles would be two chances for the edge, the ground or the radius to drift.
 *
 * `forwardRef`'d so the ONE plate an `AnchoredMenu` hangs off (the `···` chip)
 * can be measured on the press that opens it — `useMenuAnchor`'s own
 * `measureInWindow` call needs the native node, not a style prop. Every other
 * plate ignores the ref; `View` accepts a `null` one for free.
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
 * One icon target inside a plate. Icon-only, because the iOS arrangement this
 * copies drops the words — which is only allowed because the accessible name is
 * still `label`, read from the SAME field the old visible label was drawn from
 * (WCAG 4.1.2). Where a label carried a REASON rather than a name, the reason
 * stays on screen: see the toolbar's inline read-only sentence.
 */
export function ViewerChromeTarget({
  colors,
  icon,
  label,
  disabled,
  hint,
  selected,
  tone,
  /** Inside a capsule a target takes the bar's 56 — neighbours at 44 is where
   *  mis-taps start. A lone chip IS its plate, so it takes the 44 floor. */
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
  // A disabled target takes `--on-stage-soft`, NOT `--text-disabled`: the page
  // ramp's disabled ink is mixed against paper and disappears on the stage, so
  // the control would read as absent rather than as refused — and a refused
  // control that cannot be seen cannot be asked why.
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

/**
 * The three floating elements at the head of the stage. Absolutely positioned
 * and `box-none`, so the photograph beneath keeps every touch that does not land
 * on a plate — a full-width transparent row that swallowed the swipe would cost
 * the pager a strip of screen for nothing.
 */
export function ViewerTopChrome({
  colors,
  insets,
  /** The stamp's first line: the capture date, or the photograph's name when
   *  there is no capture time, or the mode's title while editing / in a show. */
  title,
  /** Its second: the clock and the place, the editor's live sentence, or the
   *  slideshow's position. */
  meta,
  /** What the photograph answers to. Never drawn — it is the stamp's accessible
   *  name, so a screen reader still hears the caption the eye now reads as a
   *  date (and as the Caption row of the info sheet). */
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
  /** The `···` plate's own node — measured on the press that opens the
   *  anchored menu hanging off it (`useMenuAnchor`). */
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
          {/* `--on-stage-soft`, never `--text-soft` — see the file header. */}
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

      {/* The slideshow's ONE action, LABELLED. It used to wear a pause glyph
          and exit the slideshow — a control whose mark promised one thing and
          whose press did another. Label and effect are now read from the same
          value (`SLIDESHOW_ACTION`), so they cannot drift apart again; the
          missing transport is a recorded non-goal, stated beside that value.
          The editor suppresses this slot entirely: its way out is `Cancel`,
          beside the commit it is the alternative to — and the slot still takes
          its width, or the stamp would slide off centre between modes. */}
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

/** `Ana on the sea wall · 10 October 2009 · 02:39`, with the name dropped when
 *  it IS the first line — a screen reader saying it twice is a stutter, not
 *  emphasis. */
function stampName(name: string, title: string, meta: string): string {
  return [name, title === name ? "" : title, meta].filter(Boolean).join(" · ");
}

/**
 * One status line inside the stage: what is true about the bytes, with the
 * single inline action. No toast, no spinner. While the editor is open it
 * carries the editor's live sentence instead — `Crop 3 : 2 · rotation −2° ·
 * nothing written yet` — which is the promise the whole mode rests on
 * (proto 4632–4645).
 */
export function ViewerStatusLine({
  colors,
  text,
  actionLabel,
  onAction,
}: {
  colors: ThemeColors;
  text: string;
  /** The ONE offer to spend the bytes (proto 4645), or null when there is
   *  none to make. The page renders no second `Load the original` chip over
   *  the photograph: two controls for one fetch is two states to keep in
   *  step. */
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
