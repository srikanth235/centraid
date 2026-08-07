// PERMISSION IS A TAKEOVER OF THE TIMELINE, NOT A SCREEN BEHIND A MENU ROW
// (Photos v4 handoff §13, proto:4335-4342; issue #712 P13).
//
// This content used to be `PhotoPermission.tsx`, a PUSHED screen reached from
// a buried `Photo access` row at the bottom of the More sheet. That arrangement
// answered the wrong question in the wrong place: a member who refused the
// camera-roll prompt does not go looking through a sheet for the word "access",
// they look at an empty grid and conclude the app is broken. The timeline never
// read the permission state at all, so the empty grid said nothing and offered
// nothing — the exact dead end §13 exists to forbid.
//
// So the content moved to where the question is ASKED: `PhotosHome` renders
// this panel in the grid's own slot the moment `photoAccessTakesOverTimeline`
// says the grant cannot produce a timeline. The band stays up (the way out of
// the app is never taken away), the head stays up, and the grid area carries
// the refusal grammar — what was tried, why it was refused, what to do.
//
// The copy and the offered controls are `photo-access.ts`, which is
// react-native-free and directly asserted. This file holds the live permission
// read, the rendering, and the two handlers.

import * as MediaLibrary from "expo-media-library";
import React, { useMemo } from "react";
import { Linking, Pressable, ScrollView, StyleSheet, View } from "react-native";

import { Text } from "../../kit/components/NativeText";
import { borders, spacing, t, useTheme } from "../../kit/theme";
import type { ThemeColors } from "../../kit/theme";
import { photoAccessCopy, photoAccessState } from "./photo-access";
import type {
  PhotoAccessAction,
  PhotoAccessControl,
  PhotoAccessState,
} from "./photo-access";

/**
 * The OS grant, as this app actually asks for it.
 *
 * `usePermissions` answers `null` for the first frame, before the OS has been
 * asked. That is genuinely unknown — not "denied" — so `state` stays null and
 * the takeover predicate declines to take anything over.
 */
export function usePhotoAccessGrant(): {
  state: PhotoAccessState | null;
  canAskAgain: boolean;
  request: () => void;
} {
  // The same two granular permissions the timeline engine walks the library
  // with, so this reports on the grant the app actually uses rather than on a
  // broader one it never asks for.
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
  /**
   * How many photographs Photos is reading off THIS device right now. Only the
   * limited state prints it; `null` leaves the meta column blank rather than
   * printing a zero the app has not finished counting.
   */
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
    // Both handlers are real and both are fallible at the OS boundary; neither
    // is caught here, so a failure reaches the app's error boundary instead of
    // becoming a control that silently does nothing.
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
            // The row that says what Photos CANNOT reach takes a 2px `net`
            // rule on its leading edge and nothing else — never a fill, never
            // a red dot (§18).
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
