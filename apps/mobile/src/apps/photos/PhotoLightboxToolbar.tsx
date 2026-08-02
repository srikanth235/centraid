import * as Haptics from "expo-haptics";
import React from "react";
import { Alert, Pressable, View } from "react-native";

import Icon from "../../kit/components/Icon";
import type { NativeOptimisticMutation } from "../../lib/replica/native-session";
import { styles } from "./PhotoLightbox.styles";
import type { PhotoAsset } from "./timeline-model";

interface PhotoLightboxToolbarProps {
  asset: PhotoAsset;
  slideshow: boolean;
  onToggleSlideshow: () => void;
  onExport: (save: boolean) => void;
  onPlacement: (kind: "add" | "move") => void;
  onWrite: (
    action: string,
    input: Record<string, string | number>,
    optimistic?: NativeOptimisticMutation[]
  ) => Promise<void>;
}

/** Mutation affordances stay source-atomic and degrade together when read-only. */
export function PhotoLightboxToolbar({
  asset,
  slideshow,
  onToggleSlideshow,
  onExport,
  onPlacement,
  onWrite,
}: PhotoLightboxToolbarProps): React.JSX.Element {
  const writable = Boolean(
    asset.assetId && asset.sourceVaultId && asset.canWrite === true
  );
  return (
    <View style={styles.toolbar}>
      <Pressable
        accessibilityLabel={slideshow ? "Pause slideshow" : "Play slideshow"}
        accessibilityRole="button"
        accessibilityState={{ selected: slideshow }}
        onPress={onToggleSlideshow}
      >
        <Icon name={slideshow ? "pause" : "play"} size={22} color="#fff" />
      </Pressable>
      <Pressable
        accessibilityLabel={
          asset.favorite ? "Remove from favorites" : "Add to favorites"
        }
        accessibilityRole="button"
        accessibilityState={{ disabled: !writable, selected: asset.favorite }}
        onPress={() => {
          void Haptics.selectionAsync();
          void onWrite(
            "update-asset",
            {
              asset_id: asset.assetId!,
              favorite: asset.favorite ? 0 : 1,
            },
            [
              {
                op: "upsert",
                entity: "media.media_asset",
                rowId: asset.assetId!,
                values: { favorite: asset.favorite ? 0 : 1 },
              },
            ]
          );
        }}
        disabled={!writable}
      >
        <Icon
          name="heart"
          size={23}
          color={writable ? (asset.favorite ? "#ff625f" : "#fff") : "#777"}
        />
      </Pressable>
      <Pressable
        accessibilityLabel="Share photo"
        accessibilityRole="button"
        onPress={() => onExport(false)}
      >
        <Icon name="share" size={23} color="#fff" />
      </Pressable>
      <Pressable
        accessibilityLabel="Add photo to another vault"
        accessibilityRole="button"
        accessibilityState={{
          disabled: !asset.assetId || !asset.scopeIds?.length,
        }}
        disabled={!asset.assetId || !asset.scopeIds?.length}
        onPress={() => onPlacement("add")}
      >
        <Icon name="copy" size={22} color="#fff" />
      </Pressable>
      <Pressable
        accessibilityLabel="Move photo to another vault"
        accessibilityRole="button"
        accessibilityState={{
          disabled: !writable || !asset.scopeIds?.length,
        }}
        disabled={!writable || !asset.scopeIds?.length}
        onPress={() => onPlacement("move")}
      >
        <Icon name="folder-plus" size={22} color={writable ? "#fff" : "#777"} />
      </Pressable>
      <Pressable
        accessibilityLabel="Export original photo"
        accessibilityRole="button"
        onPress={() => onExport(true)}
      >
        <Icon name="download" size={23} color="#fff" />
      </Pressable>
      <Pressable
        accessibilityLabel={
          asset.archived ? "Unarchive photo" : "Archive photo"
        }
        accessibilityRole="button"
        accessibilityState={{ disabled: !writable, selected: asset.archived }}
        disabled={!writable}
        onPress={() =>
          void onWrite(
            "update-asset",
            {
              asset_id: asset.assetId!,
              archived: asset.archived ? 0 : 1,
            },
            [
              {
                op: "upsert",
                entity: "media.media_asset",
                rowId: asset.assetId!,
                values: {
                  archived_at: asset.archived ? null : new Date().toISOString(),
                },
              },
            ]
          )
        }
      >
        <Icon name="archive" size={23} color={writable ? "#fff" : "#777"} />
      </Pressable>
      <Pressable
        accessibilityLabel="Move photo to trash"
        accessibilityRole="button"
        accessibilityState={{ disabled: !writable }}
        disabled={!writable}
        onPress={() =>
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
          )
        }
      >
        <Icon name="trash-2" size={23} color={writable ? "#fff" : "#777"} />
      </Pressable>
    </View>
  );
}
