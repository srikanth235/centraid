// The filmstrip, kept on the phone at 58px.
//
// Swipe and the strip are the same control approached from two directions:
// the swipe is fast, the strip is the one that shows you where you are and lets
// you jump. Dropping it here would leave the phone a slideshow with no sense of
// position (CHANGELOG §D). It is also the pointer equivalent of the swipe, so
// next/previous is never reachable by gesture alone (§15).

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

  // Paging by swipe must move the strip too, or the two controls disagree
  // about where the member is. `viewPosition: 0.5` centres the current frame.
  useEffect(() => {
    if (index < 0) return;
    // A frame that has not been laid out yet cannot be scrolled to; the strip
    // simply stays where it is rather than throwing.
    try {
      list.current?.scrollToIndex({
        animated: true,
        index,
        viewPosition: 0.5,
      });
    } catch {
      // Out of the rendered window — the next data pass will bring it in.
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
