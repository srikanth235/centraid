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

function useStageHeight(): [(el: HTMLDivElement | null) => void, number] {
  const [height, setHeight] = useState(0);
  const observer = useRef<ResizeObserver | null>(null);
  const ref = useCallback((el: HTMLDivElement | null) => {
    observer.current?.disconnect();
    if (!el) return;
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

interface Zoom {
  scale: number;
  x: number;
  y: number;
}
const FIT_ZOOM: Zoom = { scale: FIT, x: 0, y: 0 };

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
  const [painted, setPainted] = useState(false);
  const contentSrc = safeMediaUrl(asset.content_uri);
  const posterSrc = safeMediaUrl(asset.poster_uri);
  const ratio = assetRatio(asset);
  const zoomed = isZoomed(zoom.scale);
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
          {/* No caption sidecar yet — leave the track empty. Do not mute this player. */}
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
        {/* Geometry from record to bytes (§14). Image stays `.loading` until it has pixels so a failed first blob load cannot paint the broken glyph + alt. `--skel` is static (DESIGN.md). */}
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
  return (
    <div className={styles.absent} style={box}>
      <span className={styles.absentLine}>on the gateway</span>
    </div>
  );
}

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

function VideoKindLabel({ asset }: { asset: Asset }) {
  return <span className={styles.transportKind}>{videoKindLabel(asset)}</span>;
}

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
      {/* Determinate by construction (§14): a real `<progress>`, never a div `role="progressbar"`. */}
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
