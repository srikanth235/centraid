// The permission screen, native (Photos v4 handoff §13, proto:4335-4342 — the
// prototype's dedicated `permission` tab).
//
// The prototype's grammar, in order: a display headline, one paragraph in the
// reading register, the ask as the ONE filled control (§18), then ruled rows
// for what is true right now, what Photos can see, and what happens if the
// grant returns. Nothing here is a banner and nothing here is red: an
// ungranted grant is a designed state, not a fault.
//
// WHAT THIS SCREEN ANSWERS THAT NO OTHER SURFACE DID. `timeline-engine.ts` has
// carried the OS permission status in its snapshot since it was written and
// NOTHING has ever read it — a member who refused the camera-roll prompt got an
// empty grid with no sentence and no route back. The three states are named
// here, with the honest one the other surfaces cannot express: LIMITED, where
// Photos can see the photographs the member picked and nothing else. §14's rule
// for search applies just as hard here — the app will not pretend to have
// looked at photographs it was never shown.
//
// The copy and the offered controls are `photo-access.ts`, which is
// react-native-free and directly asserted. This file holds the frame, the live
// permission read, and the two handlers.

import * as MediaLibrary from "expo-media-library";
import React, { useMemo } from "react";
import { Linking, Pressable, ScrollView, StyleSheet, View } from "react-native";

import Icon from "../../kit/components/Icon";
import { Text } from "../../kit/components/NativeText";
import { borders, spacing, t, useTheme } from "../../kit/theme";
import type { ThemeColors } from "../../kit/theme";
import type { PhotosScreenProps } from "../../navigation";
import { photoAccessCopy, photoAccessState } from "./photo-access";
import type { PhotoAccessAction, PhotoAccessControl } from "./photo-access";
import PhotosScreen from "./PhotosScreen";
import { usePhotoTimeline } from "./timeline-source";

export default function PhotoPermission({
  navigation,
}: PhotosScreenProps<"PhotoPermission">): React.JSX.Element {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  // The same two granular permissions the timeline engine walks the library
  // with, so this screen reports on the grant the app actually uses rather
  // than on a broader one it never asks for.
  const [permission, requestPermission] = MediaLibrary.usePermissions({
    granularPermissions: ["photo", "video"],
  });
  const timeline = usePhotoTimeline();

  // How many photographs Photos is reading off THIS device right now. Only the
  // limited state prints it, and only once the walk has finished: a count read
  // mid-walk would be a number that is true for a second and wrong after.
  const readableCount = timeline.loading
    ? null
    : timeline.assets.filter((asset) => asset.source !== "replica").length;

  // `usePermissions` answers `null` for the first frame, before the OS has been
  // asked. That is genuinely unknown — not "denied" — so the screen says so
  // rather than accusing the member of a refusal they did not make.
  const copy = permission
    ? photoAccessCopy(photoAccessState(permission), {
        canAskAgain: permission.canAskAgain,
        readableCount,
      })
    : null;

  const run = (action: PhotoAccessAction): void => {
    // Both handlers are real and both are fallible at the OS boundary; neither
    // is caught here, so a failure reaches the app's error boundary instead of
    // becoming a control that silently does nothing.
    if (action === "ask") void requestPermission();
    else void Linking.openSettings();
  };

  return (
    <PhotosScreen current="more">
      <View style={styles.header}>
        <Pressable
          accessibilityLabel="Back to Photos"
          accessibilityRole="button"
          onPress={() => navigation.goBack()}
        >
          <Icon name="chevron-left" size={26} color={colors.text} />
        </Pressable>
        <Text style={styles.headerTitle} numberOfLines={1}>
          Photo access
        </Text>
      </View>
      <ScrollView contentContainerStyle={styles.body}>
        {copy === null ? (
          // Not an empty frame: the one honest sentence while the OS is being
          // asked, in the same register the answer will arrive in.
          <Text style={styles.lede}>
            Asking this device what Photos may read…
          </Text>
        ) : (
          <>
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
                  // The row that says what Photos CANNOT reach takes a 2px
                  // `net` rule on its leading edge and nothing else — never a
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
                    style={[
                      styles.rowMeta,
                      row.net ? { color: colors.net } : null,
                    ]}
                  >
                    {row.meta}
                  </Text>
                ) : null}
              </View>
            ))}
          </>
        )}
      </ScrollView>
    </PhotosScreen>
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
          { color: filled ? colors.onAccent : colors.text },
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
      borderRadius: 8,
      justifyContent: "center",
      minHeight: 44,
      paddingHorizontal: spacing[4],
    },
    controlText: { ...t("control") },
    header: {
      alignItems: "center",
      flexDirection: "row",
      gap: spacing[2],
      minHeight: 56,
      paddingHorizontal: spacing[4] - 2,
    },
    headerTitle: { ...t("bodyStrong"), color: colors.text, flex: 1 },
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
