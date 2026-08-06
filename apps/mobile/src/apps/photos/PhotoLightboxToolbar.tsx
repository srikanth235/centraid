// The phone's viewer bar. On the desktop the five actions sit in the top bar;
// here they sit where a thumb is, as five 56px targets. Same five names, same
// marks, same order — the phone rearranges the viewer, it does not water it
// down (CHANGELOG §D).
//
// The top bar keeps the exit and the overflow only, so this is the *only* place
// a write starts from in the viewer. Every target is labelled; Trash is the one
// destructive action and it takes `--net` as ink on the stage, not as a fill.

import * as Haptics from "expo-haptics";
import React from "react";
import { Alert, Pressable, View } from "react-native";

import Icon from "../../kit/components/Icon";
import { Text } from "../../kit/components/NativeText";
import { useTheme } from "../../kit/theme";
import type { NativeOptimisticMutation } from "../../lib/replica/native-session";
import { styles } from "./PhotoLightbox.styles";
import type { PhotoAsset } from "./timeline-model";
import { READ_ONLY_VAULT_REASON, VIEWER_BOTTOM_ACTIONS } from "./viewer-model";
import type { ViewerActionId } from "./viewer-model";

interface PhotoLightboxToolbarProps {
  asset: PhotoAsset;
  onInfo: () => void;
  onPlacement: (kind: "add" | "move") => void;
  /** Opens the editor, which is a MODE of the viewer rather than a route
   *  (§7.4). Optional only so a caller that has no editor to open cannot fire
   *  this target into nothing — never because editing is a desktop feature. */
  onEdit?: () => void;
  onWrite: (
    action: string,
    input: Record<string, string | number>,
    optimistic?: NativeOptimisticMutation[]
  ) => Promise<void>;
}

/** Mutation affordances stay source-atomic and degrade together when read-only. */
export function PhotoLightboxToolbar({
  asset,
  onInfo,
  onPlacement,
  onEdit,
  onWrite,
}: PhotoLightboxToolbarProps): React.JSX.Element {
  const { colors } = useTheme();
  const writable = Boolean(
    asset.assetId && asset.sourceVaultId && asset.canWrite === true
  );
  // Crop and rotate are raster operations on a still frame; there is no
  // non-destructive answer for a video the phone can render, so the editor does
  // not pretend to offer one.
  const editable = asset.kind === "photo" || asset.kind === "scan";
  const enabled: Record<ViewerActionId, boolean> = {
    edit: writable && editable && onEdit !== undefined,
    favorite: writable,
    info: true,
    sharing: Boolean(asset.assetId && asset.scopeIds?.length),
    trash: writable,
  };
  // A read-only vault does not hide a control; it shows why it cannot fire.
  const reason: Partial<Record<ViewerActionId, string>> = {
    edit: writable
      ? editable
        ? undefined
        : "Crop and rotate work on photographs, not on this kind of media"
      : READ_ONLY_VAULT_REASON,
    favorite: writable ? undefined : READ_ONLY_VAULT_REASON,
    sharing: asset.scopeIds?.length
      ? undefined
      : "No other vault to copy this into",
    trash: writable ? undefined : READ_ONLY_VAULT_REASON,
  };
  const run: Record<ViewerActionId, () => void> = {
    edit: () => onEdit?.(),
    favorite: () => {
      void Haptics.selectionAsync();
      void onWrite(
        "update-asset",
        { asset_id: asset.assetId!, favorite: asset.favorite ? 0 : 1 },
        [
          {
            op: "upsert",
            entity: "media.media_asset",
            rowId: asset.assetId!,
            values: { favorite: asset.favorite ? 0 : 1 },
          },
        ]
      );
    },
    info: onInfo,
    sharing: () => onPlacement("add"),
    trash: () =>
      Alert.alert(
        "Move to trash?",
        "The device original is never deleted by this action.",
        [
          { text: "Cancel" },
          {
            text: "Trash",
            style: "destructive",
            onPress: () =>
              void onWrite("delete-asset", { asset_id: asset.assetId! }, [
                {
                  op: "upsert",
                  entity: "media.media_asset",
                  rowId: asset.assetId!,
                  values: { deleted_at: new Date().toISOString() },
                },
              ]),
          },
        ]
      ),
  };
  return (
    <>
      <View
        style={[styles.actionBar, { borderTopColor: colors.stageLine }]}
        accessibilityRole="toolbar"
      >
        {VIEWER_BOTTOM_ACTIONS.map((action) => {
          const on = enabled[action.id];
          const why = reason[action.id];
          const selected =
            action.id === "favorite" ? asset.favorite : undefined;
          // One colour for the mark and the label under it: they are one
          // control, and a lit icon over a greyed word would read as a target
          // that is half available.
          const ink = on
            ? action.tone === "net" || selected === true
              ? colors.net
              : colors.onStage
            : colors.textDisabled;
          return (
            <Pressable
              // The hint still reaches a screen reader that lands directly on
              // the control; it is never the ONLY place the reason lives —
              // see the visible line below, which is what a sighted member
              // reads (§6, §18: a refusal is stated inline, never only in a
              // tooltip — and `accessibilityHint` IS that tooltip pattern for
              // a touch surface).
              accessibilityHint={on ? undefined : why}
              accessibilityLabel={action.label}
              accessibilityRole="button"
              accessibilityState={{ disabled: !on, selected }}
              disabled={!on}
              key={action.id}
              // Defense in depth (matches the web selection bar's
              // `buildSelectionActions`, §6, §18): `disabled` is what stops a
              // tap or an assistive-tech activation; this guard is what stops
              // anything that calls `onPress` directly from reaching a write
              // a read-only grant refused.
              onPress={() => {
                if (!on) return;
                run[action.id]();
              }}
              style={styles.actionTarget}
            >
              <Icon name={action.icon} size={23} color={ink} />
              {/* The label the handoff draws under every mark (proto 4611).
                  It is not decoration: five icon-only targets is five
                  guesses, and the accessible name is read from the SAME
                  field, so what a screen reader says and what the screen
                  shows cannot drift (WCAG 2.5.3). */}
              <Text
                numberOfLines={1}
                style={[styles.actionLabel, { color: ink }]}
              >
                {action.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
      {/* The read-only reason, stated inline under the bar in `--net` mono —
          the same sentence the write-refusal panel gives elsewhere in the
          viewer (READ_ONLY_VAULT_REASON), never carried only in a hint. */}
      {writable ? null : (
        <Text style={[styles.viewerReadOnlyReason, { color: colors.net }]}>
          {READ_ONLY_VAULT_REASON}
        </Text>
      )}
    </>
  );
}
