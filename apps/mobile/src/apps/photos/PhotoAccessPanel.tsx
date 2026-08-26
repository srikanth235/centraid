// PERMISSION IS A TAKEOVER OF THE TIMELINE, NOT A SCREEN BEHIND A MENU ROW
// (Photos v4 handoff §13, #712): PhotosHome renders this panel in the grid's
// slot whenever the grant can't produce a timeline.

import * as MediaLibrary from "expo-media-library";
import React, { useMemo } from "react";
import { Linking, Pressable, ScrollView, StyleSheet, View } from "react-native";

import { Text } from "../../kit/components/NativeText";
import { borders, spacing, t, useTheme, radii } from "../../kit/theme";
import type { ThemeColors } from "../../kit/theme";
import { photoAccessCopy, photoAccessState } from "./photo-access";
import type {
  PhotoAccessAction,
  PhotoAccessControl,
  PhotoAccessState,
} from "./photo-access";

/** The OS grant as this app asks for it; null before the OS has been asked —
 *  genuinely unknown, not denied. */
export function usePhotoAccessGrant(): {
  state: PhotoAccessState | null;
  canAskAgain: boolean;
  request: () => void;
} {
  // Same granular permissions the timeline engine walks the library with.
  const [permission, requestPermission] = MediaLibrary.usePermissions({
    granularPermissions: ["photo", "video"],
  });
  return {
    state: permission ? photoAccessState(permission) : null,
    canAskAgain: permission?.canAskAgain ?? false,
    request: () => void requestPermission(),
  };
}

export interface PhotoAccessPanelProps {
  state: PhotoAccessState;
  canAskAgain: boolean;
  /** Photographs read off THIS device; only the limited state prints it.
   *  `null` leaves the meta column blank, never a zero. */
  readableCount: number | null;
  onRequest: () => void;
}

export default function PhotoAccessPanel({
  state,
  canAskAgain,
  readableCount,
  onRequest,
}: PhotoAccessPanelProps): React.JSX.Element {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const copy = photoAccessCopy(state, { canAskAgain, readableCount });

  const run = (action: PhotoAccessAction): void => {
    // Fallible at the OS boundary; failures reach the error boundary,
    // never a silently dead control.
    if (action === "ask") onRequest();
    else void Linking.openSettings();
  };

  return (
    <ScrollView contentContainerStyle={styles.body}>
      <Text style={styles.headline}>{copy.headline}</Text>
      <Text style={styles.lede}>{copy.lede}</Text>
      <View style={styles.actions}>
        {copy.primary ? (
          <Control control={copy.primary} filled onPress={run} />
        ) : null}
        {copy.secondary ? (
          <Control control={copy.secondary} onPress={run} />
        ) : null}
      </View>
      {copy.rows.map((row) => (
        <View
          key={row.label}
          style={[
            styles.row,
            { borderTopColor: colors.line },
            // The cannot-reach row takes a 2px `net` leading rule — never a
            // fill, never a red dot (§18).
            row.net
              ? { borderLeftColor: colors.net, borderLeftWidth: 2 }
              : null,
            row.net ? styles.rowFlagged : null,
          ]}
        >
          <View style={styles.rowCopy}>
            <Text style={styles.rowLabel}>{row.label}</Text>
            <Text style={styles.rowSub}>{row.sub}</Text>
          </View>
          {row.meta ? (
            <Text
              style={[styles.rowMeta, row.net ? { color: colors.net } : null]}
            >
              {row.meta}
            </Text>
          ) : null}
        </View>
      ))}
    </ScrollView>
  );
}

function Control({
  control,
  filled = false,
  onPress,
}: {
  control: PhotoAccessControl;
  filled?: boolean;
  onPress: (action: PhotoAccessAction) => void;
}): React.JSX.Element {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={control.label}
      onPress={() => onPress(control.action)}
      style={[
        styles.control,
        filled
          ? { backgroundColor: colors.accentFill }
          : { borderColor: colors.line, borderWidth: borders.hairline },
      ]}
    >
      <Text
        style={[
          styles.controlText,
          { color: filled ? colors.textInv : colors.text },
        ]}
      >
        {control.label}
      </Text>
    </Pressable>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    actions: {
      flexDirection: "row",
      gap: spacing[2],
      marginBottom: spacing[5],
      marginTop: spacing[2],
    },
    body: { paddingBottom: spacing[6], paddingHorizontal: spacing[4] },
    control: {
      alignItems: "center",
      borderRadius: radii.md,
      justifyContent: "center",
      minHeight: 44,
      paddingHorizontal: spacing[4],
    },
    controlText: { ...t("control") },
    headline: { ...t("display"), color: colors.text, marginTop: spacing[3] },
    lede: { ...t("reading"), color: colors.textSoft, marginTop: spacing[3] },
    row: {
      alignItems: "center",
      borderTopWidth: borders.hairline,
      flexDirection: "row",
      gap: spacing[3],
      paddingVertical: spacing[3],
    },
    rowCopy: { flex: 1 },
    rowFlagged: { paddingLeft: spacing[3] },
    rowLabel: { ...t("smallStrong"), color: colors.text },
    rowMeta: { ...t("mono"), color: colors.textFaint },
    rowSub: { ...t("small"), color: colors.textSoft, marginTop: 2 },
  });
