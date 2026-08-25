// One page of the lightbox pager. Layout comes from the record's aspect ratio,
// so the frame does not move when the bytes land (§7.1, §14).

import { Image } from "expo-image";
import { VideoView, useVideoPlayer } from "expo-video";
import React, { useEffect, useState } from "react";
import { Pressable, View } from "react-native";
import { GestureDetector } from "react-native-gesture-handler";
import Animated, {
  useAnimatedStyle,
  useSharedValue,
} from "react-native-reanimated";

import Icon from "../../kit/components/Icon";
import { Text } from "../../kit/components/NativeText";
import { fetchAccess, FetchChoicePlaceholder } from "../../kit/fetch-gate";
import { imageSource, videoSource } from "../../kit/media/media-source";
import { useTheme } from "../../kit/theme";
import { applyZoom, buildZoomGesture } from "./lightbox-gestures";
import { styles } from "./PhotoLightbox.styles";
import type { PhotoAsset } from "./timeline-model";
import type { ScrubFrame } from "./video-scrub-strip";
import { generateScrubStrip } from "./video-scrub-strip-native";
import {
  assetAspectRatio,
  fitMedia,
  formatMediaClock,
  isZoomed,
  transportSpec,
  videoKindLabel,
  ZOOM_FIT,
  zoomIn,
  zoomOut,
  zoomReadout,
} from "./viewer-model";

const LOAD_FULL_QUALITY_LABEL = "Load full quality";

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

/** Preview plus the one tap that spends the bytes — never a spinner or a broken frame. */
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
  const { colors } = useTheme();
  return (
    <FetchChoicePlaceholder
      accessibilityLabel="Load full quality over mobile data"
      height={height}
      label={LOAD_FULL_QUALITY_LABEL}
      onFetch={onLoad}
      width={width}
    >
      <Image
        source={imageSource(asset.previewUri || asset.uri)}
        cachePolicy="memory-disk"
        recyclingKey={`${asset.id}:metered`}
        placeholder={
          asset.thumbhash ? { thumbhash: asset.thumbhash } : undefined
        }
        contentFit="contain"
        style={{ backgroundColor: colors.skel, height, width }}
      />
    </FetchChoicePlaceholder>
  );
}

/** Live photo or audio scan only. VIDEO DOES NOT GET ONE: `VideoView` draws the
 *  platform's own scrubber. */
function Transport({
  variantLabel,
  durationS,
  onPlay,
  scrubFrames,
}: {
  variantLabel: string;
  durationS: number;
  onPlay: () => void;
  /** An empty strip renders NOTHING, not a placeholder box (#724). */
  scrubFrames?: readonly ScrubFrame[];
}): React.JSX.Element {
  const { colors } = useTheme();
  const elapsed = 0;
  const fraction = durationS > 0 ? elapsed / durationS : 0;
  return (
    <View>
      {scrubFrames && scrubFrames.length > 0 ? (
        <View style={styles.scrubStrip}>
          {scrubFrames.map((frame) => (
            <Image
              key={frame.atMs}
              source={{ uri: frame.uri }}
              contentFit="cover"
              style={[
                styles.scrubStripFrame,
                { backgroundColor: colors.stageSunken },
              ]}
            />
          ))}
        </View>
      ) : null}
      <View style={[styles.transport, { borderTopColor: colors.stageLine }]}>
        <Pressable
          accessibilityLabel="Play"
          accessibilityRole="button"
          hitSlop={12}
          onPress={onPlay}
        >
          <Icon name="play" size={20} color={colors.onStage} />
        </Pressable>
        <Text style={[styles.transportClock, { color: colors.onStage }]}>
          {formatMediaClock(elapsed)}
        </Text>
        <View style={[styles.track, { backgroundColor: colors.stageSunken }]}>
          <View
            style={[
              styles.trackFill,
              {
                backgroundColor: colors.onStage,
                width: `${Math.round(fraction * 100)}%`,
              },
            ]}
          />
        </View>
        <Text style={[styles.transportClock, { color: colors.onStage }]}>
          {formatMediaClock(durationS)}
        </Text>
        <Text style={[styles.liveText, { color: colors.onStageSoft }]}>
          {variantLabel}
        </Text>
      </View>
    </View>
  );
}

export function MediaPage({
  asset,
  companionUri,
  networkType,
  originalRequested = false,
  onZoom,
  width,
  height,
}: {
  asset: PhotoAsset;
  companionUri?: string;
  networkType: string | undefined;
  /** The stage's status line is the ONE place that offer lives (proto 4645). */
  originalRequested?: boolean;
  /** The status line has to print the LIVE percentage. */
  onZoom?: (scale: number) => void;
  width: number;
  height: number;
}): React.JSX.Element {
  const { colors } = useTheme();
  const [playingLive, setPlayingLive] = useState(false);
  const [quality, setQuality] = useState<"thumb" | "preview" | "original">(
    "thumb"
  );
  const [fullQualityUnlocked, setFullQualityUnlocked] = useState(false);
  const [zoom, setZoom] = useState(1);
  // Derived during render, not in an effect: the reset lands before paint, so a
  // new asset never flashes the previous one's source.
  const [qualityAssetId, setQualityAssetId] = useState(asset.id);
  if (qualityAssetId !== asset.id) {
    setQualityAssetId(asset.id);
    setQuality("thumb");
    setFullQualityUnlocked(false);
    setZoom(1);
  }
  // Metered: nothing reaches for the original until the member asks, and the
  // status-line action states the cost before it counts as that ask.
  const access = fetchAccess(
    networkType,
    fullQualityUnlocked || originalRequested
  );
  const unlockFullQuality = (): void => setFullQualityUnlocked(true);
  // Once per Live Photo companion, never for an ordinary video (#724).
  const [scrubFrames, setScrubFrames] = useState<ScrubFrame[]>([]);
  useEffect(() => {
    let cancelled = false;
    // Scheduled: the compiler's EffectSetState rule forbids a synchronous
    // effect-body setState.
    const reset = setTimeout(() => {
      if (!cancelled) setScrubFrames([]);
      if (!companionUri || cancelled) return;
      void generateScrubStrip(
        companionUri,
        (asset.durationS ?? 0) * 1_000
      ).then((frames) => {
        if (!cancelled) setScrubFrames(frames);
      });
    }, 0);
    return () => {
      cancelled = true;
      clearTimeout(reset);
    };
  }, [companionUri, asset.durationS]);
  const scale = useSharedValue(1);
  const startScale = useSharedValue(1);
  const panX = useSharedValue(0);
  const panY = useSharedValue(0);
  // A shared value cannot be written from a render body, so the transform reset
  // is the one effect here; without it a recycled row opens magnified.
  useEffect(() => {
    applyZoom(scale, ZOOM_FIT, { x: panX, y: panY });
  }, [asset.id, panX, panY, scale]);
  const zoomStyle = useAnimatedStyle(() => ({
    // Translate BEFORE scale: the offset is in the frame's own pixels.
    transform: [
      { translateX: panX.value },
      { translateY: panY.value },
      { scale: scale.value },
    ],
  }));
  const transport = transportSpec(asset.kind, companionUri !== undefined);
  const box = fitMedia(assetAspectRatio(asset), { height, width });
  const settleZoom = (next: number): void => {
    setZoom(next);
    onZoom?.(next);
  };
  const gesture = buildZoomGesture({
    frame: box,
    offset: { x: panX, y: panY },
    onSettle: settleZoom,
    panEnabled: isZoomed(zoom),
    scale,
    startScale,
  });
  const readout = zoomReadout(zoom);
  const goToZoom = (next: number): void => {
    applyZoom(scale, next, { x: panX, y: panY });
    settleZoom(next);
  };
  // The status line's ask escalates the rung from OUTSIDE this component.
  const rung = originalRequested ? "original" : quality;

  // A video streams the original on mount — on cellular it waits behind the tap.
  if (asset.kind === "video" || (playingLive && companionUri))
    return access === "granted" ? (
      <View style={{ width }}>
        <VideoAsset
          uri={playingLive && companionUri ? companionUri : asset.originalUri}
          width={box.width}
          height={box.height}
        />
        {/* ONE transport here, and it is the platform's. This line says what the
            recording IS, by the web's `videoKindLabel` rules. */}
        <Text style={[styles.kindLabel, { color: colors.onStageSoft }]}>
          {videoKindLabel(asset)}
        </Text>
      </View>
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
      <GestureDetector gesture={gesture}>
        <Animated.View
          style={[styles.mediaCenter, { width, height }, zoomStyle]}
        >
          <Image
            source={imageSource(
              rung === "original"
                ? asset.originalUri
                : rung === "preview"
                  ? asset.previewUri || asset.uri
                  : asset.uri
            )}
            cachePolicy="memory-disk"
            recyclingKey={`${asset.id}:${rung}`}
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
            style={{
              backgroundColor: colors.skel,
              height: box.height,
              width: box.width,
            }}
          />
        </Animated.View>
      </GestureDetector>
      {/* Centred over the media: it is about the photograph. Zoomed it gains `−`
          and `Fit`, because a member at 240% needs a way down. */}
      <View
        style={[
          styles.zoomPill,
          { borderColor: colors.stageLine, backgroundColor: colors.stage },
        ]}
      >
        {readout.mode === "fit" ? null : (
          <Pressable
            accessibilityLabel="Zoom out"
            accessibilityRole="button"
            onPress={() => goToZoom(zoomOut(zoom))}
            style={styles.zoomStep}
          >
            {/* A typographic minus, not a hyphen: same width as `+`. */}
            <Text style={[styles.zoomStepLabel, { color: colors.onStage }]}>
              −
            </Text>
          </Pressable>
        )}
        <Pressable
          accessibilityLabel="Zoom in"
          accessibilityRole="button"
          accessibilityValue={{ text: readout.label }}
          onPress={() => goToZoom(zoomIn(zoom))}
          style={styles.zoomStep}
        >
          <Text style={[styles.zoomStepLabel, { color: colors.onStage }]}>
            +
          </Text>
        </Pressable>
        {readout.mode === "fit" ? null : (
          <>
            <Pressable
              accessibilityLabel="Fit to the screen"
              accessibilityRole="button"
              onPress={() => goToZoom(ZOOM_FIT)}
              style={styles.zoomStep}
            >
              <Text style={[styles.zoomStepLabel, { color: colors.onStage }]}>
                Fit
              </Text>
            </Pressable>
            {/* `--on-stage-soft`: `--text-soft` reads 2.85:1 on the stage. */}
            <Text style={[styles.zoomReadout, { color: colors.onStageSoft }]}>
              {readout.label}
            </Text>
          </>
        )}
      </View>
      {companionUri ? (
        <Transport
          durationS={asset.durationS ?? 0}
          onPlay={() => setPlayingLive(true)}
          scrubFrames={scrubFrames}
          variantLabel={transport?.kindLabel ?? "live photo"}
        />
      ) : null}
    </View>
  );
}
