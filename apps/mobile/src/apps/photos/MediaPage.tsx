// One page of the lightbox pager: the asset itself, its Live Photo companion,
// and the metered-connection gate in front of full-quality bytes.
//
// Split out of `PhotoLightbox` because it is a different job. The screen owns
// the pager, the toolbar and the vault writes; this file owns what a single
// asset looks like as its quality rung climbs from thumbnail to original, and
// the decision — per photo, per session — about whether the phone should spend
// cellular data getting there.

import { Image } from "expo-image";
import { VideoView, useVideoPlayer } from "expo-video";
import React, { useState } from "react";
import { Pressable, View } from "react-native";
import { GestureDetector } from "react-native-gesture-handler";
import Animated, {
  useAnimatedStyle,
  useSharedValue,
} from "react-native-reanimated";

import Icon from "../../kit/components/Icon";
import { Text } from "../../kit/components/NativeText";
import { imageSource, videoSource } from "../../kit/media/media-source";
import {
  fullQualityAccess,
  LOAD_FULL_QUALITY_LABEL,
  LOAD_ORIGINAL_LABEL,
} from "./full-quality-gate";
import { buildZoomGesture } from "./lightbox-gestures";
import { styles } from "./PhotoLightbox.styles";
import type { PhotoAsset } from "./timeline-model";

function VideoAsset({
  uri,
  width,
  height,
}: {
  uri: string;
  width: number;
  height: number;
}): React.JSX.Element {
  const player = useVideoPlayer(videoSource(uri), (instance) => {
    instance.loop = false;
  });
  return (
    <VideoView
      player={player}
      nativeControls
      contentFit="contain"
      style={{ width, height }}
    />
  );
}

/**
 * Stands in for a video whose original would come down over mobile data: the
 * still preview the app already holds, plus the one tap that spends the bytes.
 */
function MeteredPlaceholder({
  asset,
  width,
  height,
  onLoad,
}: {
  asset: PhotoAsset;
  width: number;
  height: number;
  onLoad: () => void;
}): React.JSX.Element {
  return (
    <View style={[styles.mediaCenter, { width, height }]}>
      <Image
        source={imageSource(asset.previewUri || asset.uri)}
        cachePolicy="memory-disk"
        recyclingKey={`${asset.id}:metered`}
        placeholder={
          asset.thumbhash ? { thumbhash: asset.thumbhash } : undefined
        }
        contentFit="contain"
        style={{ width, height }}
      />
      <Pressable
        accessibilityLabel="Load full quality over mobile data"
        accessibilityRole="button"
        onPress={onLoad}
        style={styles.originalButton}
      >
        <Icon name="download" size={15} color="#fff" />
        <Text style={styles.liveText}>{LOAD_FULL_QUALITY_LABEL}</Text>
      </Pressable>
    </View>
  );
}

export function MediaPage({
  asset,
  companionUri,
  networkType,
  width,
  height,
}: {
  asset: PhotoAsset;
  companionUri?: string;
  networkType: string | undefined;
  width: number;
  height: number;
}): React.JSX.Element {
  const [playingLive, setPlayingLive] = useState(false);
  const [quality, setQuality] = useState<"thumb" | "preview" | "original">(
    "thumb"
  );
  // The user's consent to spend mobile data on THIS photo's original.
  const [fullQualityUnlocked, setFullQualityUnlocked] = useState(false);
  // Re-point at a different asset ⇒ start again at the thumbnail. Adjusting the
  // state during render (React's documented "derive state from props" escape
  // hatch) rather than in an effect means the reset lands before paint, so a new
  // asset can never flash the previous one's full-resolution source.
  const [qualityAssetId, setQualityAssetId] = useState(asset.id);
  if (qualityAssetId !== asset.id) {
    setQualityAssetId(asset.id);
    setQuality("thumb");
    setFullQualityUnlocked(false);
  }
  // On a metered connection nothing reaches for the original until the user
  // asks. Off cellular this is always "granted", so behaviour is unchanged.
  const access = fullQualityAccess(networkType, fullQualityUnlocked);
  const unlockFullQuality = (): void => setFullQualityUnlocked(true);
  const scale = useSharedValue(1);
  const startScale = useSharedValue(1);
  const zoomStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));
  const zoom = buildZoomGesture(scale, startScale);
  // A video page streams the original the moment it mounts — the most expensive
  // ungated fetch in the app. On cellular it waits behind the same tap.
  if (asset.kind === "video")
    return access === "granted" ? (
      <VideoAsset uri={asset.originalUri} width={width} height={height} />
    ) : (
      <MeteredPlaceholder
        asset={asset}
        width={width}
        height={height}
        onLoad={unlockFullQuality}
      />
    );
  if (playingLive && companionUri)
    return access === "granted" ? (
      <VideoAsset uri={companionUri} width={width} height={height} />
    ) : (
      <MeteredPlaceholder
        asset={asset}
        width={width}
        height={height}
        onLoad={unlockFullQuality}
      />
    );
  return (
    <View style={{ width, height }}>
      <GestureDetector gesture={zoom}>
        <Animated.View
          style={[styles.mediaCenter, { width, height }, zoomStyle]}
        >
          <Image
            source={imageSource(
              quality === "original"
                ? asset.originalUri
                : quality === "preview"
                  ? asset.previewUri || asset.uri
                  : asset.uri
            )}
            cachePolicy="memory-disk"
            recyclingKey={`${asset.id}:${quality}`}
            placeholder={
              asset.thumbhash ? { thumbhash: asset.thumbhash } : undefined
            }
            contentFit="contain"
            transition={120}
            onLoad={() => {
              if (
                quality === "thumb" &&
                asset.previewUri &&
                asset.previewUri !== asset.uri
              )
                setQuality("preview");
            }}
            style={{ width, height }}
          />
        </Animated.View>
      </GestureDetector>
      {companionUri ? (
        <Pressable
          accessibilityLabel="Play Live Photo"
          accessibilityRole="button"
          style={styles.liveButton}
          onPress={() => setPlayingLive(true)}
        >
          <Icon name="play" size={18} color="#fff" />
          <Text style={styles.liveText}>LIVE</Text>
        </Pressable>
      ) : null}
      {quality !== "original" && asset.originalUri !== asset.previewUri ? (
        <Pressable
          accessibilityLabel={
            access === "granted"
              ? "Load original photo"
              : "Load full quality over mobile data"
          }
          accessibilityRole="button"
          style={styles.originalButton}
          onPress={() => {
            unlockFullQuality();
            setQuality("original");
          }}
        >
          <Icon name="maximize" size={15} color="#fff" />
          <Text style={styles.liveText}>
            {access === "granted"
              ? LOAD_ORIGINAL_LABEL
              : LOAD_FULL_QUALITY_LABEL}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}
