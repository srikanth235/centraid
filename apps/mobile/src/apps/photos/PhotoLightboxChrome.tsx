import React from "react";
import { Pressable, View } from "react-native";
import type { View as RNView } from "react-native";
import type { EdgeInsets } from "react-native-safe-area-context";

import Icon from "../../kit/components/Icon";
import { Text } from "../../kit/components/NativeText";
import Tappable from "../../kit/components/Tappable";
import { TEST_IDS } from "../../kit/test-ids";
import type { ThemeColors } from "../../kit/theme";
import { styles } from "./PhotoLightbox.styles";
import { SLIDESHOW_ACTION, VIEWER_CHROME_INSET } from "./viewer-model";

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

export function ViewerChromeTarget({
  colors,
  icon,
  label,
  disabled,
  hint,
  selected,
  tone,
  wide,
  testID,
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
  testID?: string;
  onPress: () => void;
}): React.JSX.Element {
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
      testID={testID}
      style={[styles.chromeTarget, wide ? styles.chromeTargetWide : null]}
    >
      <Icon name={icon} size={23} color={ink} />
    </Pressable>
  );
}

export function ViewerTopChrome({
  colors,
  insets,
  title,
  meta,
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
          testID={TEST_IDS.photos.viewerBack}
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
          {/* `--on-stage-soft`, never `--text-soft`. */}
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

      {/* LABELLED, never a pause glyph. Label and effect both from `SLIDESHOW_ACTION`. Editor keeps the slot's width or the stamp slides off centre. */}
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
            testID={TEST_IDS.photos.viewerMore}
          />
        </ViewerChromePlate>
      )}
    </View>
  );
}

function stampName(name: string, title: string, meta: string): string {
  return [name, title === name ? "" : title, meta].filter(Boolean).join(" · ");
}

export function ViewerStatusLine({
  colors,
  text,
  actionLabel,
  onAction,
}: {
  colors: ThemeColors;
  text: string;
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
        <Tappable
          accessibilityLabel={actionLabel}
          accessibilityRole="button"
          hitSlop={10}
          onPress={onAction}
        >
          <Text style={[styles.statusAction, { color: colors.link }]}>
            {actionLabel}
          </Text>
        </Tappable>
      ) : null}
    </View>
  );
}
