import React, { useMemo, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import Icon from "../../kit/components/Icon";
import { Text } from "../../kit/components/NativeText";
import { useReplica } from "../../kit/replica/ReplicaProvider";
import ReplicaStatusBar from "../../kit/replica/ReplicaStatusBar";
import { useReplicaRefresh } from "../../kit/replica/useReplicaRefresh";
import {
  surfaceWriteFailure,
  surfaceWriteOutcome,
} from "../../kit/replica/write-outcome";
import { family, useTheme } from "../../kit/theme";
import type { PhotosScreenProps } from "../../navigation";
import PhotoTimeline from "./PhotoTimeline";
import { sectionPhotoAssets } from "./timeline-model";
import { usePhotoTimeline } from "./timeline-source";

export default function PhotoStateView({
  route,
  navigation,
}: PhotosScreenProps<"PhotoStateView">): React.JSX.Element {
  const { colors } = useTheme();
  const { session } = useReplica();
  const { refreshing, refreshNow } = useReplicaRefresh();
  const timeline = usePhotoTimeline();
  const [selection, setSelection] = useState(new Set<string>());
  const mode = route.params.mode;
  const assets = useMemo(
    () =>
      timeline.assets.filter((asset) =>
        mode === "favorites"
          ? asset.favorite && !asset.deleted
          : mode === "archive"
            ? asset.archived && !asset.deleted
            : asset.deleted
      ),
    [mode, timeline.assets]
  );
  const title =
    mode === "favorites"
      ? "Favorites"
      : mode === "archive"
        ? "Archive"
        : "Trash";
  const apply = async (): Promise<void> => {
    const selectedAssets = assets.filter(
      (item) => selection.has(item.id) && item.assetId
    );
    const applyNext = async (index: number): Promise<void> => {
      const asset = selectedAssets[index];
      if (!asset) return;
      if (!session) return;
      const result = await session.write(
        "photos",
        mode === "trash"
          ? {
              action: "restore",
              input: { asset_id: asset.assetId! },
              optimistic: [
                {
                  op: "upsert",
                  entity: "media.media_asset",
                  rowId: asset.assetId!,
                  values: { deleted_at: null, purge_at: null },
                },
              ],
            }
          : {
              action: "update-asset",
              input: {
                asset_id: asset.assetId!,
                ...(mode === "archive" ? { archived: 0 } : { favorite: 0 }),
              },
              optimistic: [
                {
                  op: "upsert",
                  entity: "media.media_asset",
                  rowId: asset.assetId!,
                  values:
                    mode === "archive"
                      ? { archived_at: null }
                      : { favorite: 0 },
                },
              ],
            }
      );
      surfaceWriteOutcome(result);
      return applyNext(index + 1);
    };
    try {
      await applyNext(0);
      setSelection(new Set());
    } catch (error) {
      surfaceWriteFailure(error, `${title} change not saved`);
    }
  };
  return (
    <SafeAreaView
      style={[styles.safe, { backgroundColor: colors.bg }]}
      edges={["top"]}
    >
      <View style={styles.header}>
        <Pressable
          accessibilityLabel="Back to Photos"
          accessibilityRole="button"
          onPress={() => navigation.goBack()}
        >
          <Icon name="chevron-left" size={26} color={colors.text} />
        </Pressable>
        <View style={styles.copy}>
          <Text style={[styles.title, { color: colors.text }]}>{title}</Text>
          <Text style={[styles.meta, { color: colors.textSoft }]}>
            {assets.length} items
            {mode === "trash" ? " · device originals untouched" : ""}
          </Text>
        </View>
        {selection.size ? (
          <Pressable
            accessibilityLabel={`${mode === "trash" ? "Restore" : "Remove"} ${selection.size} selected photos`}
            accessibilityRole="button"
            onPress={() => void apply()}
          >
            <Text style={[styles.action, { color: colors.accent }]}>
              {mode === "trash" ? "Restore" : "Remove"}
            </Text>
          </Pressable>
        ) : null}
      </View>
      <ReplicaStatusBar />
      {assets.length ? (
        <PhotoTimeline
          sections={sectionPhotoAssets(
            assets.map((asset) => ({
              ...asset,
              archived: false,
              deleted: false,
            }))
          )}
          selection={selection}
          onSelectionChange={setSelection}
          onOpen={(asset) =>
            navigation.navigate("PhotoLightbox", { assetId: asset.id })
          }
          refreshing={refreshing}
          onRefresh={refreshNow}
        />
      ) : (
        <View style={styles.empty}>
          <Text style={[styles.meta, { color: colors.textSoft }]}>
            Nothing here.
          </Text>
        </View>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  action: { fontFamily: family.sansBold, fontSize: 13 },
  copy: { flex: 1, marginLeft: 10 },
  empty: { alignItems: "center", flex: 1, justifyContent: "center" },
  header: {
    alignItems: "center",
    flexDirection: "row",
    minHeight: 56,
    paddingHorizontal: 14,
  },
  meta: { fontFamily: family.sansRegular, fontSize: 11, marginTop: 3 },
  safe: { flex: 1 },
  title: { fontFamily: family.sansBold, fontSize: 18 },
});
