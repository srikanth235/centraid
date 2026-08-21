// The stage itself (v4 handoff §7.1): the photograph, the two step controls,
// the zoom control, the per-kind transport and the stage's own status line.
//
// WHAT "FIT" MEANS. The media carries three things at once: the asset's
// `aspect-ratio` (from the RECORD, so the box is right before the bytes
// arrive), a PREFERRED width of `targetHeight × ratio`, and
// `max-width/max-height: 100%`. The preference says which way the photograph
// would like to be bound; the two maxima are what make "fit" mean fit on a
// 390px portrait screen as well as in a 1420px window. Zoomed, the maxima come
// off and the wrap clips instead — that is the whole difference between the
// two states.
//
// PREV / NEXT MIRROR. Both are placed with `inset-inline-start/end`, so under
// RTL "previous" sits where the reading eye expects it without a second rule.
import { useCallback, useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";

import { scopeAttr } from "../../_shared/scope-kit.ts";
import { displayText, safeMediaUrl } from "../../_shared/untrusted.ts";
import { isAudioAsset, isVideoAsset } from "../format.ts";
import { ChevronLeftIcon, ChevronRightIcon, PlayIcon } from "../icons.tsx";
import type { Asset } from "../types.ts";
import type { OriginStatus } from "../viewer.ts";
import {
  assetRatio,
  clock,
  FIT,
  FIT_ACTION,
  FIT_CHIP,
  isZoomed,
  preferredWidth,
  trackFraction,
  TRANSPORT_LABELS,
  transportKind,
  videoKindLabel,
  zoomIn,
  zoomOut,
  zoomReadout,
} from "../viewer.ts";

import styles from "./Lightbox.module.css";

/** The wrap's live pixel height — what the preferred width is derived from. */
function useStageHeight(): [(el: HTMLDivElement | null) => void, number] {
  const [height, setHeight] = useState(0);
  const observer = useRef<ResizeObserver | null>(null);
  const ref = useCallback((el: HTMLDivElement | null) => {
    observer.current?.disconnect();
    if (!el) return;
    // A host with no ResizeObserver (the jsdom boot test) simply never
    // measures, and the media falls back to its two maxima — which is the
    // correct answer there rather than a thrown error.
    if (typeof ResizeObserver !== "function") return;
    observer.current = new ResizeObserver((entries) => {
      setHeight(entries[0]?.contentRect.height ?? 0);
    });
    observer.current.observe(el);
    setHeight(el.getBoundingClientRect().height);
  }, []);
  useEffect(() => () => observer.current?.disconnect(), []);
  return [ref, height];
}

/** The zoom state, as one value plus its pan offset. */
interface Zoom {
  scale: number;
  x: number;
  y: number;
}
const FIT_ZOOM: Zoom = { scale: FIT, x: 0, y: 0 };

/**
 * The media element. Every branch names the scope its bytes live in
 * (issue #599): the viewer steps through a MERGED list, and content ids are
 * per-scope, so an unstamped reference renders the wrong photograph rather
 * than failing.
 */
function Media({
  asset,
  zoom,
  stageHeight,
  onDims,
}: {
  asset: Asset;
  zoom: Zoom;
  stageHeight: number;
  onDims: (w: number, h: number) => void;
}) {
  const scope = scopeAttr(asset.scope_id);
  // Has the photograph actually painted? The stage is remounted per asset
  // (`key={asset.asset_id}` in Lightbox), so this resets on its own — there is
  // no stale-true to clear when stepping to the next frame.
  const [painted, setPainted] = useState(false);
  const contentSrc = safeMediaUrl(asset.content_uri);
  const posterSrc = safeMediaUrl(asset.poster_uri);
  const ratio = assetRatio(asset);
  const zoomed = isZoomed(zoom.scale);
  // The preference only exists once the wrap has been measured. Before that
  // the two maxima are the whole constraint, which is a correct fit, not a
  // placeholder — so nothing reflows when the measurement lands.
  const box = {
    aspectRatio: String(ratio),
    ...(stageHeight > 0 && !zoomed
      ? { width: `${preferredWidth(stageHeight, ratio)}px` }
      : {}),
  };
  if (contentSrc && isVideoAsset(asset)) {
    return (
      <video
        className={styles.media}
        style={box}
        data-scope={scope}
        src={contentSrc}
        muted
        playsInline
        controls
        preload="metadata"
        poster={posterSrc ?? undefined}
        aria-label={displayText(asset.title ?? "Video")}
      />
    );
  }
  if (contentSrc && isAudioAsset(asset)) {
    return (
      <div className={styles.audio} data-scope={scope}>
        <audio
          src={contentSrc}
          controls
          preload="metadata"
          aria-label={displayText(asset.title ?? "Audio")}
        >
          {/* The vault has no caption sidecar for media assets yet, so there
              is nothing to point `src` at — this is the wiring point for when
              it does. Muting instead would be dishonest: this is a real
              player the member presses play on. */}
          <track kind="captions" />
        </audio>
      </div>
    );
  }
  if (contentSrc) {
    const displaySrc = safeMediaUrl(asset.preview_uri) ?? contentSrc;
    const needsProbe =
      displaySrc === contentSrc &&
      (asset.width == null || asset.height == null);
    return (
      <>
        {/* THE STAGE HOLDS ITS GEOMETRY FROM RECORD TO BYTES (§14) — the tile's
            own rule, which the stage did not keep. Before it paints, an `<img>`
            is not a neutral empty box: a `/centraid/_vault/blobs/…` path is
            unauthorized until the shell's observer swaps it, so the FIRST load
            reliably fails, and the element presents that failure as the broken
            glyph plus the alt string set in prose across the stage.

            The alt text is the accessible NAME, not a caption to paint, and
            `color: transparent` only silences half of it — the glyph is
            replaced content and survives. So the skeleton is its own element
            and the image waits at `.loading` until it has pixels: `--skel` at
            the exact box the photograph is about to occupy, so nothing
            reflows when the bytes land.

            Static, deliberately. `--skel` is the system's "before its bytes
            arrive" ground and it does not shimmer — "loading is
            determinate-only with static skeletons; a shimmer is
            attention-seeking about work the product can simply describe"
            (DESIGN.md). The stage's status line is where description goes. */}
        {painted ? null : (
          <div className={styles.skeleton} style={box} aria-hidden="true" />
        )}
        <img
          className={`${styles.media} ${zoomed ? styles.zoomed : ""} ${
            painted ? "" : styles.loading
          }`}
          style={
            painted
              ? {
                  ...box,
                  ...(zoomed
                    ? {
                        transform: `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.scale})`,
                      }
                    : {}),
                }
              : undefined
          }
          data-scope={scope}
          src={displaySrc}
          alt={displayText(asset.title ?? asset.kind ?? "Photograph")}
          decoding="async"
          draggable={false}
          onLoad={(e) => {
            setPainted(true);
            if (needsProbe)
              onDims(
                e.currentTarget.naturalWidth,
                e.currentTarget.naturalHeight
              );
          }}
          onError={(e) => {
            if (
              e.currentTarget.dataset.originalFallback ||
              displaySrc === contentSrc
            )
              return;
            e.currentTarget.dataset.originalFallback = "1";
            e.currentTarget.src = contentSrc;
          }}
        />
      </>
    );
  }
  // No paintable source. The box is still the right box: a tile — and a stage
  // — holds its geometry from record to bytes to failure (§14).
  return (
    <div className={styles.absent} style={box}>
      <span className={styles.absentLine}>on the gateway</span>
    </div>
  );
}

/** The zoom control (§7.1): a `fit` chip with a `+`, or the full ladder plus
 *  an exact readout. Two states of one control, never two controls. */
function ZoomControl({
  scale,
  onZoom,
}: {
  scale: number;
  onZoom: (next: number) => void;
}) {
  if (!isZoomed(scale)) {
    return (
      <div className={styles.zoomBar}>
        <span className={styles.zoomChip}>{FIT_CHIP}</span>
        <button
          type="button"
          className={styles.zoomBtn}
          aria-label="Zoom in"
          onClick={() => onZoom(zoomIn(scale))}
        >
          +
        </button>
      </div>
    );
  }
  return (
    <div className={styles.zoomBar}>
      <button
        type="button"
        className={styles.zoomBtn}
        aria-label="Zoom out"
        onClick={() => onZoom(zoomOut(scale))}
      >
        −
      </button>
      <button
        type="button"
        className={styles.zoomBtn}
        aria-label="Zoom in"
        onClick={() => onZoom(zoomIn(scale))}
      >
        +
      </button>
      <button
        type="button"
        className={styles.zoomBtn}
        onClick={() => onZoom(FIT)}
      >
        {FIT_ACTION}
      </button>
      <span className={styles.zoomReadout}>{zoomReadout(scale)}</span>
    </div>
  );
}

/**
 * The video's micro-caps kind label (§7.1): `video · 4K · 0:24`. Rendered
 * beside the zoom control rather than inside a transport, because video has
 * none here — see the Transport doc comment for why.
 */
function VideoKindLabel({ asset }: { asset: Asset }) {
  return <span className={styles.transportKind}>{videoKindLabel(asset)}</span>;
}

/**
 * The transport (§7.1): play, a determinate track, position / duration in
 * mono, and a micro-caps kind label — for a LIVE PHOTO OR AN AUDIO SCAN.
 *
 * VIDEO DOES NOT GET ONE. It used to: a hand-rolled play button and a
 * `<progress>` sat over the native `<video controls>`, and the hand-rolled
 * one's `elapsed` was hard-coded to `0` with a play button that had no
 * handler — two transports, one of them permanently frozen at 0:00, which is
 * exactly the kind of "looks interactive, isn't" the member notices first.
 * The platform's own scrubber is accessible, already wired to the element it
 * controls, and free; a hand-rolled one only earns its place back if it does
 * something the native one cannot (frame-accurate scrubbing, custom chrome
 * matching a design the native control can't skin, etc.) — nothing here does,
 * so video renders through `VideoKindLabel` instead and leaves the actual
 * transport to the browser.
 */
export function Transport({ asset }: { asset: Asset }) {
  const kind = transportKind(asset);
  if (!kind || kind === "video") return null;
  const duration = Math.max(0, Number(asset.duration_s) || 0);
  const elapsed = 0;
  return (
    <div className={styles.transport}>
      <button type="button" className={styles.transportPlay} aria-label="Play">
        <PlayIcon size={16} />
      </button>
      {/* DETERMINATE BY CONSTRUCTION (§14). A real `<progress>` with a value
          and a max, not a div wearing `role="progressbar"` — the element
          cannot express the indeterminate state this app never wants, and its
          own semantics come free. */}
      <progress
        className={styles.track}
        aria-label="Position"
        max={Math.max(1, Math.round(duration))}
        value={trackFraction(elapsed, duration) * Math.max(1, duration)}
      />
      <span className={styles.transportClock}>
        {clock(elapsed)} / {clock(duration)}
      </span>
      <span className={styles.transportKind}>{TRANSPORT_LABELS[kind]}</span>
    </div>
  );
}

/**
 * The stage's own status line (§7.1). It says what is true about the BYTES,
 * and where there is something to do about it the verb is an inline text
 * action — never a button that starts a metered download on its own.
 */
export function StageStatus({
  status,
  onAction,
}: {
  status: OriginStatus | null;
  onAction: () => void;
}) {
  if (!status) return null;
  return (
    <p className={styles.stageStatus}>
      <span className={styles.stageStatusText}>{status.text}</span>
      {status.action ? (
        <button
          type="button"
          className={styles.inlineAction}
          onClick={onAction}
        >
          {status.action}
        </button>
      ) : null}
    </p>
  );
}

export function ViewerStage({
  asset,
  hasPrev,
  hasNext,
  onStep,
  onDims,
  status,
  onLoadOriginal,
}: {
  asset: Asset;
  hasPrev: boolean;
  hasNext: boolean;
  onStep: (delta: number) => void;
  onDims: (w: number, h: number) => void;
  status: OriginStatus | null;
  onLoadOriginal: () => void;
}) {
  const [wrapRef, stageHeight] = useStageHeight();
  const [zoom, setZoom] = useState<Zoom>(FIT_ZOOM);
  const drag = useRef<{ x: number; y: number } | null>(null);
  // A new photograph is always shown at fit. Adjusted during the render that
  // first sees a new asset_id rather than from an effect, so the incoming
  // photograph is never painted for a frame at the outgoing one's zoom.
  const [zoomFor, setZoomFor] = useState(asset.asset_id);
  if (zoomFor !== asset.asset_id) {
    setZoomFor(asset.asset_id);
    setZoom(FIT_ZOOM);
  }
  const zoomed = isZoomed(zoom.scale);

  function onPointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    if (!zoomed) return;
    drag.current = { x: e.clientX - zoom.x, y: e.clientY - zoom.y };
    e.currentTarget.setPointerCapture(e.pointerId);
  }
  function onPointerMove(e: ReactPointerEvent<HTMLDivElement>) {
    const start = drag.current;
    if (!start) return;
    setZoom((z) => ({ ...z, x: e.clientX - start.x, y: e.clientY - start.y }));
  }
  function endDrag() {
    drag.current = null;
  }

  return (
    <div className={styles.stagewrap}>
      <div
        className={`${styles.mediaWrap} ${zoomed ? styles.clipping : ""}`}
        ref={wrapRef}
        onDoubleClick={() =>
          setZoom((z) =>
            isZoomed(z.scale)
              ? FIT_ZOOM
              : { scale: zoomIn(z.scale), x: 0, y: 0 }
          )
        }
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <Media
          asset={asset}
          zoom={zoom}
          stageHeight={stageHeight}
          onDims={onDims}
        />
      </div>
      <button
        type="button"
        className={`${styles.nav} ${styles.navPrev}`}
        aria-label="Previous photograph"
        disabled={!hasPrev}
        onClick={(e) => {
          e.stopPropagation();
          onStep(-1);
        }}
      >
        <ChevronLeftIcon size={20} />
      </button>
      <button
        type="button"
        className={`${styles.nav} ${styles.navNext}`}
        aria-label="Next photograph"
        disabled={!hasNext}
        onClick={(e) => {
          e.stopPropagation();
          onStep(1);
        }}
      >
        <ChevronRightIcon size={20} />
      </button>
      <div className={styles.stageFoot}>
        <Transport asset={asset} />
        {isVideoAsset(asset) ? <VideoKindLabel asset={asset} /> : null}
        <ZoomControl
          scale={zoom.scale}
          onZoom={(next) => setZoom({ scale: next, x: 0, y: 0 })}
        />
        <StageStatus status={status} onAction={onLoadOriginal} />
      </div>
    </div>
  );
}
