// One page of the lightbox pager: the asset itself, its transport when it has
// one, and the metered-connection gate in front of full-quality bytes.
//
// Separate from `PhotoLightbox`: that screen owns
// the pager, the bars and the vault writes; this file owns what a single asset
// looks like as its quality rung climbs from thumbnail to original, and the
// decision — per photo, per session — about whether the phone should spend
// cellular data getting there.
//
// The media is laid out from the asset record's own aspect ratio, so "fit"
// means fit on a 390px portrait screen and the frame does not move when the
// bytes land (§7.1, §14). Un-zoomed the stage offers `fit`; zoomed it reads out
// exactly — `240% · drag to pan` — because a zoom with no number is a state the
// member cannot describe.

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

/** Copy for the tap that spends the data. Plain words, no units, no jargon. */
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

/**
 * Stands in for an original that would come down over mobile data: the preview
 * the app already holds, plus the one tap that spends the bytes. Never a
 * spinner and never a broken frame — the shape is known, so the shape is drawn.
 *
 * The gate itself (`fetchAccess`) and this stated-choice contract
 * (`FetchChoicePlaceholder`) live in `kit/fetch-gate/` — shared machinery, not
 * a photos concern — this wrapper only supplies the photo-specific preview
 * source and copy.
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

/**
 * Play, a determinate track, a clock, and a micro-caps kind label — for a LIVE
 * PHOTO OR AN AUDIO SCAN.
 *
 * VIDEO DOES NOT GET ONE. `VideoView` already draws the platform's own
 * scrubber: it is accessible, already wired to the element it controls, and
 * free, so a hand-rolled transport earns its place only by doing something
 * the platform's cannot. The web makes the same call in `ViewerStage.tsx`
 * (see its `Transport` doc comment).
 *
 * This is the live photo's play affordance, whose track sits at zero because
 * playback genuinely has not started — pressing it hands the companion video
 * to the platform player, which is where the real transport is.
 */
function Transport({
  variantLabel,
  durationS,
  onPlay,
  scrubFrames,
}: {
  variantLabel: string;
  durationS: number;
  onPlay: () => void;
  /** Real poster frames down this clip (#724), or empty wherever
   *  `expo-video-thumbnails` cannot honestly produce one — see
   *  `video-scrub-strip-native.ts`. An empty strip renders NOTHING here
   *  rather than a placeholder box; the track below is unchanged either way. */
  scrubFrames?: readonly ScrubFrame[];
}): React.JSX.Element {
  const { colors } = useTheme();
  // Determinate from the first frame: the record carries the duration, so the
  // track never has to admit it does not know how long this is.
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
  /**
   * The member asked for the original — from the stage's status line, which is
   * the ONE place that offer lives (proto 4645). This page carries no second
   * `Load the original` chip of its own: the same fetch offered twice on one
   * screen is two labels and two states for one thing. The screen owns the
   * ask; this page owns what to do about it.
   */
  originalRequested?: boolean;
  /**
   * The settled magnification, reported up. The stage's status line belongs to
   * the screen but the gesture belongs to this page, and the line has to print
   * the LIVE percentage (`240% · drag to pan · double tap returns to fit`) — a
   * status that says one number while the transform holds another is the same
   * class of lie as the frozen transport this file just lost.
   */
  onZoom?: (scale: number) => void;
  width: number;
  height: number;
}): React.JSX.Element {
  const { colors } = useTheme();
  const [playingLive, setPlayingLive] = useState(false);
  const [quality, setQuality] = useState<"thumb" | "preview" | "original">(
    "thumb"
  );
  // The user's consent to spend mobile data on THIS photo's original.
  const [fullQualityUnlocked, setFullQualityUnlocked] = useState(false);
  const [zoom, setZoom] = useState(1);
  // Re-point at a different asset ⇒ start again at the thumbnail. Adjusting the
  // state during render (React's documented "derive state from props" escape
  // hatch) rather than in an effect means the reset lands before paint, so a new
  // asset can never flash the previous one's full-resolution source.
  const [qualityAssetId, setQualityAssetId] = useState(asset.id);
  if (qualityAssetId !== asset.id) {
    setQualityAssetId(asset.id);
    setQuality("thumb");
    setFullQualityUnlocked(false);
    setZoom(1);
  }
  // On a metered connection nothing reaches for the original until the user
  // asks. Off cellular this is always "granted", so behaviour is unchanged.
  //
  // The status line's action counts as that ask: it is rendered beside copy
  // that states the cost first (`loading it spends mobile data`), which is the
  // whole of the gate's stated-choice contract — the member reads what it
  // costs, then decides. That is the same contract the removed chip honoured.
  const access = fetchAccess(
    networkType,
    fullQualityUnlocked || originalRequested
  );
  const unlockFullQuality = (): void => setFullQualityUnlocked(true);
  // The scrub-preview strip (#724) — generated once per Live Photo
  // companion, before playback starts, and never for an ordinary video (see
  // `video-scrub-strip.ts`'s header for why the platform's own `VideoView`
  // scrubber is left alone). The async generator resolves into a `.then`
  // callback rather than a synchronous effect-body `setState`, the same
  // pattern `PhotosHome.tsx`'s `backupConsent` hydration already uses.
  const [scrubFrames, setScrubFrames] = useState<ScrubFrame[]>([]);
  useEffect(() => {
    let cancelled = false;
    // The reset and the (re)generation both happen in scheduled callbacks —
    // the compiler's EffectSetState rule forbids a synchronous effect-body
    // setState, and the empty-strip reset genuinely belongs to the same
    // "companion changed" transition as the fetch it precedes.
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
  // Re-pointing at a different asset must return the TRANSFORM to fit too, not
  // just the `zoom` state beside it. A shared value cannot be written from a
  // render body (that is the mutation the React compiler rejects), so this is
  // the one effect on the page — without it a recycled row could open the next
  // photograph already magnified and shoved off-centre.
  useEffect(() => {
    applyZoom(scale, ZOOM_FIT, { x: panX, y: panY });
  }, [asset.id, panX, panY, scale]);
  const zoomStyle = useAnimatedStyle(() => ({
    // Translate BEFORE scale: the offset is accumulated in the frame's own
    // pixels (that is what the clamp is computed against), and a translation
    // applied after a scale would be multiplied by it.
    transform: [
      { translateX: panX.value },
      { translateY: panY.value },
      { scale: scale.value },
    ],
  }));
  const transport = transportSpec(asset.kind, companionUri !== undefined);
  // The frame the photograph will occupy, from the record — not from the bytes.
  const box = fitMedia(assetAspectRatio(asset), { height, width });
  /** Every way to a rung ends here, so the readout, the status line and the
   *  transform can never be three different opinions about one magnification. */
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
  /** One rung, one place: `+`, `−`, `Fit` and the double tap all land here. */
  const goToZoom = (next: number): void => {
    applyZoom(scale, next, { x: panX, y: panY });
    settleZoom(next);
  };
  // The quality rung actually on screen. The status line's ask (`originalRequested`)
  // climbs the ladder to the top from OUTSIDE this component, so the one offer
  // in the stage drives the same escalation the removed in-stage chip did.
  const rung = originalRequested ? "original" : quality;

  // A video page streams the original the moment it mounts — the most expensive
  // ungated fetch in the app. On cellular it waits behind the same tap.
  if (asset.kind === "video" || (playingLive && companionUri))
    return access === "granted" ? (
      <View style={{ width }}>
        <VideoAsset
          uri={playingLive && companionUri ? companionUri : asset.originalUri}
          width={box.width}
          height={box.height}
        />
        {/* ONE transport in this tree, and it belongs to the platform (see the
            `Transport` doc comment). What is left for us to say is what this
            recording IS — `video · 4K · 0:24`, composed by the same rules as
            the web's `videoKindLabel`, so a member who opens one video on both
            clients reads one label. */}
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
      {/* The ladder (proto 4536–4540), CENTRED over the media rather than
          tucked into a corner: it is about the photograph, so it sits on it.
          At fit it is one `+`; zoomed it is `−` `+` `Fit` and the exact
          readout, because a member at 240% needs a way down as well as up —
          the single toggle this replaces could only slam between two rungs. */}
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
            {/* A typographic minus, not a hyphen: it is the same width as the
                `+` it stands beside, which is what keeps the pill from
                shuffling as the ladder changes shape. */}
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
            {/* `--on-stage-soft`, not `--text-soft`: this line sits ON the
                stage, where `--text-soft` reads 2.85:1 in light mode. */}
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
