// The phone's viewer controls. On the desktop the five actions sit in the top
// bar; here they sit where a thumb is. Same five names, same marks, same order —
// the phone rearranges the viewer, it does not water it down (CHANGELOG §D).
//
// ANATOMY: chip · capsule · chip, not one bar of five equal cells. The grouping
// is `VIEWER_BOTTOM_GROUPS` and the argument for it is stated there: the two
// ends carry the actions with consequences outside this photograph (Copy to
// vault, which reaches outside this vault; Trash, the only destructive one),
// and the capsule carries the three that do not. Flattening the groups still
// reproduces the desktop order.
//
// THE LABELS ARE GONE FROM THE SCREEN, AND THAT IS THE ONE THING THIS COSTS.
// Five drawn words under five marks is what the v4 handoff asked for; the iOS
// arrangement we are copying draws none, and at chip size there is nowhere to
// put them that does not turn a 44 target into a 70 one. What survives is the
// contract underneath the words: every target still takes its `accessibilityLabel`
// from `action.label`, the same field the label was drawn from, so nothing an
// assistive technology says has changed. What must NOT be traded away with them
// is a REASON — a refusal is a sentence a sighted member has to be able to read,
// so `READ_ONLY_VAULT_REASON` is still rendered inline under the row, in visible
// `--net` mono, exactly as before (§6, §18).
//
// The floating chrome above the stage keeps the back and the overflow only, so
// this is still the ONLY place a write starts from in the viewer. Trash takes
// `--net` as ink, never as a fill.

import * as Haptics from "expo-haptics";
import React from "react";
import { Alert, View } from "react-native";

import { Text } from "../../kit/components/NativeText";
import { useTheme } from "../../kit/theme";
import type { NativeOptimisticMutation } from "../../lib/replica/native-session";
import { styles } from "./PhotoLightbox.styles";
import { ViewerChromePlate, ViewerChromeTarget } from "./PhotoLightboxChrome";
import type { PhotoAsset } from "./timeline-model";
import {
  READ_ONLY_VAULT_REASON,
  VIEWER_BOTTOM_GROUPS,
  viewerAction,
} from "./viewer-model";
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
    copy: Boolean(asset.assetId && asset.scopeIds?.length),
    edit: writable && editable && onEdit !== undefined,
    favorite: writable,
    info: true,
    trash: writable,
  };
  // A read-only vault does not hide a control; it shows why it cannot fire.
  const reason: Partial<Record<ViewerActionId, string>> = {
    copy: asset.scopeIds?.length
      ? undefined
      : "No other vault to copy this into",
    edit: writable
      ? editable
        ? undefined
        : "Crop and rotate work on photographs, not on this kind of media"
      : READ_ONLY_VAULT_REASON,
    favorite: writable ? undefined : READ_ONLY_VAULT_REASON,
    trash: writable ? undefined : READ_ONLY_VAULT_REASON,
  };
  const run: Record<ViewerActionId, () => void> = {
    copy: () => onPlacement("add"),
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
      <View style={styles.actionRow} accessibilityRole="toolbar">
        {VIEWER_BOTTOM_GROUPS.map((group) => (
          <ViewerChromePlate colors={colors} key={group.actions.join("-")}>
            {group.actions.map((id) => {
              const action = viewerAction(id);
              const on = enabled[id];
              const why = reason[id];
              const selected = id === "favorite" ? asset.favorite : undefined;
              return (
                <ViewerChromeTarget
                  colors={colors}
                  disabled={!on}
                  // The hint still reaches a screen reader that lands directly
                  // on the control; it is never the ONLY place the reason lives
                  // — see the visible line below, which is what a sighted member
                  // reads (§6, §18: a refusal is stated inline, never only in a
                  // tooltip — and `accessibilityHint` IS that tooltip pattern
                  // for a touch surface).
                  hint={why}
                  icon={action.icon}
                  key={id}
                  label={action.label}
                  // Defense in depth (matches the web selection bar's
                  // `buildSelectionActions`, §6, §18): `disabled` is what stops
                  // a tap or an assistive-tech activation; this guard is what
                  // stops anything that calls `onPress` directly from reaching a
                  // write a read-only grant refused.
                  onPress={() => {
                    if (!on) return;
                    run[id]();
                  }}
                  selected={selected}
                  tone={action.tone}
                  wide={group.shape === "capsule"}
                />
              );
            })}
          </ViewerChromePlate>
        ))}
      </View>
      {/* The read-only reason, stated inline under the row in `--net` mono —
          the same sentence the write-refusal panel gives elsewhere in the
          viewer (READ_ONLY_VAULT_REASON), never carried only in a hint. This is
          what makes dropping the drawn labels honest: a NAME can move into the
          accessible layer, a REASON cannot. */}
      {writable ? null : (
        <Text style={[styles.viewerReadOnlyReason, { color: colors.net }]}>
          {READ_ONLY_VAULT_REASON}
        </Text>
      )}
    </>
  );
}
