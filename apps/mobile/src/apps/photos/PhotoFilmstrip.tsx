import { Image } from "expo-image";
import React, { useCallback, useEffect, useRef } from "react";
import { FlatList, Pressable } from "react-native";
import type { ListRenderItemInfo } from "react-native";

import { imageSource } from "../../kit/media/media-source";
import { useTheme } from "../../kit/theme";
import { styles } from "./PhotoLightbox.styles";
import type { PhotoAsset } from "./timeline-model";
import { FILMSTRIP } from "./viewer-model";

const CURRENT_STRIDE = FILMSTRIP.current + FILMSTRIP.gap;
const NEIGHBOUR_STRIDE = FILMSTRIP.neighbour + FILMSTRIP.gap;

export function PhotoFilmstrip({
  assets,
  currentId,
  onSelect,
}: {
  assets: readonly PhotoAsset[];
  currentId: string;
  onSelect: (assetId: string) => void;
}): React.JSX.Element {
  const { colors } = useTheme();
  const list = useRef<FlatList<PhotoAsset>>(null);
  const index = assets.findIndex((asset) => asset.id === currentId);

  useEffect(() => {
    if (index < 0) return;
    try {
      list.current?.scrollToIndex({
        animated: true,
        index,
        viewPosition: 0.5,
      });
    } catch {
      // Intentionally empty.
    }
  }, [index]);

  const renderFrame = useCallback(
    ({ item }: ListRenderItemInfo<PhotoAsset>) => {
      const current = item.id === currentId;
      return (
        <Pressable
          accessibilityLabel={`Show photograph ${item.filename ?? item.id}`}
          accessibilityRole="button"
          accessibilityState={{ selected: current }}
          onPress={() => onSelect(item.id)}
          style={styles.filmstripFrame}
        >
          <Image
            source={imageSource(item.uri)}
            cachePolicy="memory-disk"
            recyclingKey={`${item.id}:strip`}
            placeholder={
              item.thumbhash ? { thumbhash: item.thumbhash } : undefined
            }
            contentFit="cover"
            style={[
              current ? styles.filmstripCurrent : styles.filmstripNeighbour,
              {
                backgroundColor: colors.skel,
                ...(current ? { borderColor: colors.onStage } : {}),
              },
            ]}
          />
        </Pressable>
      );
    },
    [colors.onStage, colors.skel, currentId, onSelect]
  );

  return (
    <FlatList
      ref={list}
      accessibilityLabel="Filmstrip"
      data={assets}
      getItemLayout={(_, position) => ({
        index: position,
        length: position === index ? CURRENT_STRIDE : NEIGHBOUR_STRIDE,
        offset: NEIGHBOUR_STRIDE * position,
      })}
      horizontal
      keyExtractor={(asset) => asset.id}
      renderItem={renderFrame}
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.filmstripContent}
      style={[styles.filmstrip, { borderTopColor: colors.stageLine }]}
    />
  );
}
