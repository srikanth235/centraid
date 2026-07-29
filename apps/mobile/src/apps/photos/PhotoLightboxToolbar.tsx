import { Feather } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import React from "react";
import { Alert, Pressable, View } from "react-native";

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
      <Pressable onPress={onToggleSlideshow}>
        <Feather name={slideshow ? "pause" : "play"} size={22} color="#fff" />
      </Pressable>
      <Pressable
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
        <Feather
          name="heart"
          size={23}
          color={writable ? (asset.favorite ? "#ff625f" : "#fff") : "#777"}
        />
      </Pressable>
      <Pressable onPress={() => onExport(false)}>
        <Feather name="share" size={23} color="#fff" />
      </Pressable>
      <Pressable
        disabled={!asset.assetId || !asset.scopeIds?.length}
        onPress={() => onPlacement("add")}
      >
        <Feather name="copy" size={22} color="#fff" />
      </Pressable>
      <Pressable
        disabled={!writable || !asset.scopeIds?.length}
        onPress={() => onPlacement("move")}
      >
        <Feather
          name="folder-plus"
          size={22}
          color={writable ? "#fff" : "#777"}
        />
      </Pressable>
      <Pressable onPress={() => onExport(true)}>
        <Feather name="download" size={23} color="#fff" />
      </Pressable>
      <Pressable
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
        <Feather name="archive" size={23} color={writable ? "#fff" : "#777"} />
      </Pressable>
      <Pressable
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
        <Feather name="trash-2" size={23} color={writable ? "#fff" : "#777"} />
      </Pressable>
    </View>
  );
}
