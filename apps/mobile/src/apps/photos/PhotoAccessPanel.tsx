import * as MediaLibrary from "expo-media-library";
import React, { useMemo } from "react";
import { Linking, Pressable, ScrollView, StyleSheet, View } from "react-native";

import { Text } from "../../kit/components/NativeText";
import { TEST_IDS } from "../../kit/test-ids";
import { borders, spacing, t, useTheme, radii } from "../../kit/theme";
import type { ThemeColors } from "../../kit/theme";
import { photoAccessCopy, photoAccessState } from "./photo-access";
import type {
  PhotoAccessAction,
  PhotoAccessControl,
  PhotoAccessState,
} from "./photo-access";

export function usePhotoAccessGrant(): {
  state: PhotoAccessState | null;
  canAskAgain: boolean;
  request: () => void;
} {
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
    if (action === "ask") onRequest();
    else void Linking.openSettings();
  };

  return (
    <ScrollView
      contentContainerStyle={styles.body}
      testID={TEST_IDS.photos.accessPanel}
    >
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
      testID={
        control.action === "ask"
          ? TEST_IDS.photos.accessAsk
          : TEST_IDS.photos.accessSettings
      }
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
