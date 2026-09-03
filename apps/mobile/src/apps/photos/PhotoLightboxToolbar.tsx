import * as Haptics from "expo-haptics";
import React from "react";
import { Alert, View } from "react-native";

import { Text } from "../../kit/components/NativeText";
import { TEST_ID_PREFIXES } from "../../kit/test-ids";
import { useTheme } from "../../kit/theme";
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
  onPlacement,
  onSaveToMyVault,
  onEdit,
  onWrite,
}: PhotoLightboxToolbarProps): React.JSX.Element {
  const { colors } = useTheme();
  const writable = Boolean(
    asset.assetId && asset.sourceVaultId && asset.canWrite === true
  );
  const editable = asset.kind === "photo" || asset.kind === "scan";
  const enabled: Record<ViewerActionId, boolean> = {
    copy: Boolean(onSaveToMyVault ?? (asset.assetId && asset.scopeIds?.length)),
    edit: writable && editable && onEdit !== undefined,
    favorite: writable,
    info: true,
    trash: writable,
  };
  const reason: Partial<Record<ViewerActionId, string>> = {
    copy:
      onSaveToMyVault || asset.scopeIds?.length
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
    copy: () => (onSaveToMyVault ? onSaveToMyVault() : onPlacement("add")),
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
      Alert.alert(
        "Move to trash?",
        "The device original is never deleted by this action.",
        [
          { text: "Cancel" },
          {
            text: "Trash",
            style: "destructive",
            onPress: () =>
              void onWrite("delete-asset", { asset_id: asset.assetId! }),
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
              const label =
                id === "copy" && onSaveToMyVault
                  ? "Save to my vault"
                  : action.label;
              return (
                <ViewerChromeTarget
                  colors={colors}
                  disabled={!on}
                  hint={why}
                  icon={action.icon}
                  key={id}
                  label={label}
                  onPress={() => {
                    if (!on) return;
                    run[id]();
                  }}
                  selected={selected}
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
        <Text style={[styles.viewerReadOnlyReason, { color: colors.net }]}>
          {READ_ONLY_VAULT_REASON}
        </Text>
      )}
    </>
  );
}
