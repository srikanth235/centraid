// The frame every Photos surface sits in (§F): wrapping a screen in it is what
// keeps the band, the Home capsule and the reserved band height from being
// forgotten on a pushed screen. The selection bar REPLACES the band, never
// stacks above it. Safe-area top is an explicit inset — `SafeAreaView edges`
// resolves zero inside this stack's modal cover.

import { useNavigation } from "@react-navigation/native";
import React, { useMemo, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import {
  SELECTION_ACTION_TARGET,
  buildSelectionActions,
  selectionBarReason,
} from "@centraid/blueprints/apps/_shared/selection-engine";
import type {
  SelectionHandler,
  SelectionShelfKind,
} from "@centraid/blueprints/apps/_shared/selection-engine";

import {
  BAND_BORDER,
  BAND_INSET,
  bandSurfaceStyle,
} from "../../kit/band-surface";
import { useBandOwner } from "../../kit/band/band-owner";
import Icon from "../../kit/components/Icon";
import { Text } from "../../kit/components/NativeText";
import { t, useTheme } from "../../kit/theme";
import type { ThemeColors } from "../../kit/theme";
import type { PhotosShellNavigation } from "../../navigation";
import VaultBar from "../../screens/home/VaultBar";
import { resolveMoreRowRoute } from "./photos-band";
import type { BandDestinationKey, PhotosMoreRowKey } from "./photos-band";
import PhotosBand from "./PhotosBand";
import PhotosMoreSheet from "./PhotosMoreSheet";

export interface PhotosSelectionProps {
  count: number;
  shelf: SelectionShelfKind;
  copyLabel: string;
  readOnlyReason: string | null;
  favorite: SelectionHandler;
  addToAlbum: SelectionHandler;
  share: SelectionHandler;
  download: SelectionHandler;
  trash: SelectionHandler;
}

export interface PhotosScreenProps {
  current: BandDestinationKey;
  children: React.ReactNode;
  selection?: PhotosSelectionProps;
}

export default function PhotosScreen({
  current,
  children,
  selection,
}: PhotosScreenProps): React.JSX.Element {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<PhotosShellNavigation>();
  const [moreOpen, setMoreOpen] = useState(false);
  // The FRAME's latch, not Photos' (#712).
  const { bandOwner } = useBandOwner("photos");

  const selecting = (selection?.count ?? 0) > 0;

  const onDestination = (key: BandDestinationKey): void => {
    if (key === "more") {
      setMoreOpen(true);
      return;
    }
    // POP, never push: `navigate` pushes a second `PhotosHome` on RN7.
    navigation.popTo("PhotosHome", { destination: key });
  };

  const onMoreRow = (key: PhotosMoreRowKey): void => {
    setMoreOpen(false);
    const route = resolveMoreRowRoute(key);
    navigation.navigate(route.screen, route.params);
  };

  return (
    <View
      style={[
        styles.frame,
        { backgroundColor: colors.bg, paddingTop: insets.top },
      ]}
    >
      {/* The vault lockup on every route (see `VaultBar`): which vault, which
          gateway, and the product's two global verbs. */}
      <VaultBar />
      {/* Content ends ABOVE the bar STRUCTURALLY (§G): a `flex:1` slot over a
          `flex:none` bar, never padding, which clears only the content's end. */}
      <View style={styles.body}>{children}</View>

      {/* Exactly ONE bar at the foot: the selection bar or the band, never both. */}
      {selecting && selection ? (
        // The home-indicator lift is added here only; `PhotosBand` adds its own.
        <View style={{ paddingBottom: insets.bottom }}>
          <SelectionBottomBar selection={selection} />
        </View>
      ) : (
        <PhotosBand
          owner={bandOwner}
          current={current}
          onSelect={onDestination}
          // `goBack()` no-ops on a deep link; `navigate` pushes a second Home.
          onHome={() => navigation.popTo("Home")}
        />
      )}

      <PhotosMoreSheet
        visible={moreOpen}
        onClose={() => setMoreOpen(false)}
        onSelect={onMoreRow}
      />
    </View>
  );
}

/** Actions only; count and Done stay in the screen's head. */
function SelectionBottomBar({
  selection,
}: {
  selection: PhotosSelectionProps;
}): React.JSX.Element {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const actions = buildSelectionActions({
    count: selection.count,
    shelf: selection.shelf,
    copyLabel: selection.copyLabel,
    readOnlyReason: selection.readOnlyReason,
    favorite: selection.favorite,
    addToAlbum: selection.addToAlbum,
    share: selection.share,
    download: selection.download,
    trash: selection.trash,
  });
  const reason = selectionBarReason(actions);
  return (
    <View>
      {reason ? (
        <Text style={[styles.selectionReason, { color: colors.net }]}>
          {reason}
        </Text>
      ) : null}
      <View style={styles.selectionBar} accessibilityRole="toolbar">
        {actions.map((action) => (
          <Pressable
            accessibilityLabel={action.label}
            accessibilityRole="button"
            accessibilityState={{ disabled: action.disabled }}
            // Never the ONLY place the reason lives (§6).
            accessibilityHint={action.disabled ? action.reason : undefined}
            disabled={action.disabled}
            key={action.id}
            // Second half of the disabled rule — no synthetic press gets through.
            onPress={() => {
              if (action.disabled) return;
              action.run();
            }}
            style={styles.selectionTarget}
          >
            <Icon
              name={action.icon}
              size={22}
              color={
                action.disabled
                  ? colors.textDisabled
                  : action.destructive
                    ? colors.net
                    : colors.text
              }
            />
            <Text
              numberOfLines={1}
              style={[
                styles.selectionLabel,
                {
                  color: action.disabled
                    ? colors.textDisabled
                    : action.destructive
                      ? colors.net
                      : colors.text,
                },
              ]}
            >
              {action.label}
            </Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    body: { flex: 1 },
    frame: { flex: 1 },
    selectionBar: {
      alignItems: "center",
      flexDirection: "row",
      minHeight: SELECTION_ACTION_TARGET,
      paddingHorizontal: 4,
      ...bandSurfaceStyle(colors.bg, colors.line, BAND_BORDER),
    },
    selectionLabel: { ...t("control"), textAlign: "center" },
    selectionReason: {
      ...t("mono"),
      marginBottom: 6,
      marginHorizontal: BAND_INSET,
      textAlign: "center",
    },
    selectionTarget: {
      alignItems: "center",
      flex: 1,
      gap: 2,
      justifyContent: "center",
      minHeight: SELECTION_ACTION_TARGET,
      paddingVertical: 4,
    },
  });
