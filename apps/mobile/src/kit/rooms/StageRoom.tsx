// STAGE (#1015, R-NY-14): the seventh room — a full-bleed stage for ONE piece
// of media. The photo lightbox, its slideshow, a video.
//
// Not a PushedPage with the header taken off: a stage has no PlaceHeader and no
// band, because the photograph IS the screen and a strip across the top is a
// second ground (§7). What the room owns is the three things every stage needs
// and none may decide for itself:
//
//   the ground     `--stage` from the theme in both schemes, never a literal —
//                  the chrome on it inks from `--on-stage`/`--stage-line`, or
//                  it vanishes;
//   the way out    ONE close act, reached two ways: the swipe-down, and a close
//                  control — the caller's chrome, handed `close` so it cannot
//                  invent its own navigation, or the room's own close key when
//                  a caller brings none. A stage always has a visible way out;
//   the safe area  the stage runs edge to edge UNDER the notch and the home
//                  indicator (a SafeAreaView would letterbox it), so the ground
//                  takes no inset and every control on it carries its own.
//
// The chrome is a render prop, not children: it paints AFTER the media, which
// is what puts it on the stage (`zIndex` alone is not enough on every Android
// surface), and `overlay` paints after both, for the stage's own sheets.

import React from "react";
import { Pressable, View } from "react-native";
import { GestureDetector } from "react-native-gesture-handler";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import Icon from "../components/Icon";
import { useTheme } from "../theme";
import { styles } from "./rooms.styles";
import { buildStageDismiss } from "./stage-gesture";

/** What the room hands the stage's chrome. */
export interface StageChrome {
  /** The room's way out — the same act the swipe-down performs. */
  close: () => void;
}

export interface StageRoomProps {
  /** Leaves the stage. The swipe-down and every close control call this. */
  onClose: () => void;
  /** The drag's other direction, when the stage has a second act for it. */
  onSwipeUp?: () => void;
  /** The media, full-bleed. */
  children?: React.ReactNode;
  /** The stage's own floating chrome; omitted, the room draws a close key. */
  chrome?: (stage: StageChrome) => React.ReactNode;
  /** The stage's sheets and menus: siblings painted over the chrome. */
  overlay?: React.ReactNode;
  /** For the end-to-end flows that name the stage by id. */
  testID?: string;
}

export default function StageRoom({
  onClose,
  onSwipeUp,
  children,
  chrome,
  overlay,
  testID,
}: StageRoomProps): React.JSX.Element {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const dismiss = buildStageDismiss(onClose, onSwipeUp);
  return (
    <GestureDetector gesture={dismiss}>
      {/* A plain View, NOT a SafeAreaView: the ground is full-bleed and must
          run edge to edge, which a SafeAreaView would letterbox. */}
      <View
        style={[styles.stage, { backgroundColor: colors.stage }]}
        testID={testID}
      >
        {children}
        {chrome ? (
          chrome({ close: onClose })
        ) : (
          // `box-none` so every touch that misses the key is the media's.
          <View
            pointerEvents="box-none"
            style={[styles.stageHead, { paddingTop: insets.top }]}
          >
            <Pressable
              accessibilityLabel="Close"
              accessibilityRole="button"
              onPress={onClose}
              style={[
                styles.stageClose,
                {
                  backgroundColor: colors.stageSunken,
                  borderColor: colors.stageLine,
                },
              ]}
            >
              {/* `x`, not a back chevron: a stage is LEFT, not gone back from
                  — and `--on-stage`, never page ink, because the key floats on
                  a photograph. */}
              <Icon color={colors.onStage} name="x" size={20} />
            </Pressable>
          </View>
        )}
        {overlay}
      </View>
    </GestureDetector>
  );
}
