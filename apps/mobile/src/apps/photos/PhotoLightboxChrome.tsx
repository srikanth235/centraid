// THE STAGE'S CHROME (issue #712 P18, extracted from ./PhotoLightbox).
//
// THE SEAM. `PhotoLightbox` owns the viewer's STATE — which photograph, which
// mode (viewing / editing / slideshow), what the last write did, whether the
// full-quality bytes have been unlocked. The two strips that frame the stage
// own none of it: the bar above and the status line below are pure views over
// values the screen has already decided. Pulling them out is what makes that
// division visible rather than merely true, and it is the seam a future viewer
// engine claims — both strips are the same shape on every media surface.
//
// BOTH STRIPS ARE ON THE STAGE, AND THAT IS A TOKEN RULE, NOT A LOOK. The
// stage is one colour in BOTH themes, so ink here comes from `--on-stage` /
// `--on-stage-soft` and hairlines from `--stage-line`. A page token would land
// at 2.85:1 in light mode. That constraint is why these two live together in
// one module instead of one file each: they are the only two strips that must
// be read against the stage, and the rule is stated once here.

import React from "react";
import { Pressable, View } from "react-native";
import type { EdgeInsets } from "react-native-safe-area-context";

import Icon from "../../kit/components/Icon";
import { Text } from "../../kit/components/NativeText";
import type { ThemeColors } from "../../kit/theme";
import { styles } from "./PhotoLightbox.styles";
import { SLIDESHOW_ACTION, VIEWER_TOP_BAR_HEIGHT } from "./viewer-model";

/** 52px, exit and overflow only — the five actions live below (proto 2601). */
export function ViewerTopBar({
  colors,
  insets,
  title,
  meta,
  editing,
  slideshow,
  onClose,
  onLeaveSlideshow,
  onOverflow,
}: {
  colors: ThemeColors;
  insets: EdgeInsets;
  title: string;
  meta: string;
  editing: boolean;
  slideshow: boolean;
  onClose: () => void;
  onLeaveSlideshow: () => void;
  onOverflow: () => void;
}): React.JSX.Element {
  return (
    <View
      style={[
        styles.topbar,
        {
          borderBottomColor: colors.stageLine,
          height: VIEWER_TOP_BAR_HEIGHT + insets.top,
          paddingTop: insets.top,
        },
      ]}
    >
      <Pressable
        accessibilityLabel="Close photo viewer"
        accessibilityRole="button"
        hitSlop={12}
        onPress={onClose}
      >
        {/* ✕, not a chevron (proto 2601). A chevron-down describes the
            swipe-down dismissal, which still works — but the CONTROL is a
            close, and a mark that describes the gesture beside it rather
            than its own effect is a mark pointing at the wrong thing. */}
        <Icon name="x" size={26} color={colors.onStage} />
      </Pressable>
      <View style={styles.topbarTitle}>
        <Text numberOfLines={1} style={{ color: colors.onStage }}>
          {title}
        </Text>
        {/* `--on-stage-soft`, never `--text-soft` — see the file header. */}
        <Text
          numberOfLines={1}
          style={[styles.topbarCapture, { color: colors.onStageSoft }]}
        >
          {meta}
        </Text>
      </View>
      {/* The slideshow's ONE action, LABELLED. It used to wear a pause glyph
          and exit the slideshow — a control whose mark promised one thing and
          whose press did another. Label and effect are now read from the same
          value (`SLIDESHOW_ACTION`), so they cannot drift apart again; the
          missing transport is a recorded non-goal, stated beside that value.
          The editor suppresses this slot entirely: its way out is `Cancel`,
          beside the commit it is the alternative to. */}
      {editing ? null : slideshow ? (
        <Pressable
          accessibilityLabel={SLIDESHOW_ACTION.label}
          accessibilityRole="button"
          hitSlop={12}
          onPress={() => {
            if (SLIDESHOW_ACTION.effect === "leave") onLeaveSlideshow();
          }}
        >
          <Text style={[styles.statusAction, { color: colors.onStage }]}>
            {SLIDESHOW_ACTION.label}
          </Text>
        </Pressable>
      ) : (
        <Pressable
          accessibilityLabel="More actions"
          accessibilityRole="button"
          hitSlop={12}
          onPress={onOverflow}
        >
          <Icon name="more-vertical" size={22} color={colors.onStage} />
        </Pressable>
      )}
    </View>
  );
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
   *  none to make. The page used to render a second `Load the original` chip
   *  over the photograph; two controls for one fetch is two states to keep in
   *  step, and they did not stay in step. */
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
