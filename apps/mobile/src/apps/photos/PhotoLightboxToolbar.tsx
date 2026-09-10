// Same five as desktop (CHANGELOG §D), chip·capsule·chip. Labels gone (44
// not 70); `accessibilityLabel` from `action.label`. REASON stays visible
// as whatever sentence `viewerWriteRefusal` returns (§6, §18): read-only
// vault, or not-in-a-vault-yet for a device row. Trash `--net` ink, never fill.

import * as Haptics from "expo-haptics";
import React from "react";
import { View } from "react-native";

import { useConfirmDestructive } from "../../kit/components/ConfirmSheet";
import { Text } from "../../kit/components/NativeText";
import { TEST_ID_PREFIXES } from "../../kit/test-ids";
import { useTheme } from "../../kit/theme";
import { styles } from "./PhotoLightbox.styles";
import { ViewerChromePlate, ViewerChromeTarget } from "./PhotoLightboxChrome";
import { TRASH_KEEPS_THE_ORIGINAL } from "./photos-confirm-copy";
import type { PhotoAsset } from "./timeline-model";
import {
  VIEWER_BOTTOM_GROUPS,
  viewerAction,
  viewerWriteRefusal,
} from "./viewer-model";
import type { ViewerActionId } from "./viewer-model";
import { viewerToolbarStates } from "./viewer-toolbar-states";

interface PhotoLightboxToolbarProps {
  asset: PhotoAsset;
  onInfo: () => void;
  /** Present only for a commons item this member has not kept yet. */
  onSaveToMyVault?: () => void;
  onEdit?: () => void;
  onWrite: (
    action: string,
    input: Record<string, string | number>
  ) => Promise<void>;
}

export function PhotoLightboxToolbar({
  asset,
  onInfo,
  onSaveToMyVault,
  onEdit,
  onWrite,
}: PhotoLightboxToolbarProps): React.JSX.Element {
  const { colors } = useTheme();
  // The refusal ladder, shared with the `···` menu and `PhotoLightbox`'s
  // `writeReason` (`viewerWriteRefusal`): a device row the seat has not pulled
  // yet is NOT a read-only vault, and must not be told it is.
  const refusal = viewerWriteRefusal({
    writable: asset.canWrite === true,
    hasVaultAsset: Boolean(asset.assetId && asset.sourceVaultId),
  });
  const writable = refusal === undefined;
  // The table is DATA (#1015 B10) — see `viewerToolbarStates`. Every disabled
  // control here renders in `--on-stage-soft` with `accessibilityState.disabled`
  // and its reason as the hint; the row's shared refusal stays on screen below.
  const states = viewerToolbarStates({
    writable: asset.canWrite === true,
    hasVaultAsset: Boolean(asset.assetId && asset.sourceVaultId),
    // Crop/rotate are raster on a still; do not pretend a video has a
    // non-destructive editor.
    editable: asset.kind === "photo" || asset.kind === "scan",
    canSaveToMyVault: Boolean(onSaveToMyVault),
    hasEditor: onEdit !== undefined,
  });
  const { confirmDestructive, confirmSheet } = useConfirmDestructive();
  const run: Record<ViewerActionId, () => void> = {
    copy: () => onSaveToMyVault?.(),
    edit: () => onEdit?.(),
    favorite: () => {
      void Haptics.selectionAsync();
      void onWrite("update-asset", {
        asset_id: asset.assetId!,
        favorite: asset.favorite ? 0 : 1,
      });
    },
    info: onInfo,
    trash: () =>
      confirmDestructive({
        body: TRASH_KEEPS_THE_ORIGINAL,
        noun: "photograph",
        onConfirm: () =>
          void onWrite("delete-asset", { asset_id: asset.assetId! }),
        verb: "Trash",
      }),
  };
  return (
    <>
      {confirmSheet}
      <View style={styles.actionRow} accessibilityRole="toolbar">
        {VIEWER_BOTTOM_GROUPS.map((group) => (
          <ViewerChromePlate colors={colors} key={group.actions.join("-")}>
            {group.actions.map((id) => {
              const action = viewerAction(id);
              const on = states[id].enabled;
              const why = states[id].reason;
              const selected = id === "favorite" ? asset.favorite : undefined;
              const label =
                id === "copy" && onSaveToMyVault
                  ? "Save to my vault"
                  : action.label;
              return (
                <ViewerChromeTarget
                  colors={colors}
                  disabled={!on}
                  // Hint for AT; never the only place the reason lives (§6, §18).
                  hint={why}
                  icon={action.icon}
                  key={id}
                  label={label}
                  // `disabled` stops tap/AT; this guard stops a direct `onPress` on a refused write.
                  onPress={() => {
                    if (!on) return;
                    run[id]();
                  }}
                  selected={selected}
                  // The action's own id — `label` swaps to "Save to my vault"
                  // on a foreign asset, so it cannot be a locator.
                  testID={`${TEST_ID_PREFIXES.photosViewerAction}${id}`}
                  tone={action.tone}
                  wide={group.shape === "capsule"}
                />
              );
            })}
          </ViewerChromePlate>
        ))}
      </View>
      {/* Visible refusal under the row — a NAME can move to AT, a REASON cannot. */}
      {writable ? null : (
        <View
          style={[
            styles.viewerReadOnlyPlate,
            {
              backgroundColor: colors.stageSunken,
              borderColor: colors.stageLine,
            },
          ]}
        >
          <Text style={[styles.viewerReadOnlyReason, { color: colors.net }]}>
            {refusal}
          </Text>
        </View>
      )}
    </>
  );
}
