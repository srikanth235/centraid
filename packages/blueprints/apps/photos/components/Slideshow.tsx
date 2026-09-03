import { useCallback, useEffect, useRef, useState } from "react";

import { scopeAttr } from "../../_shared/scope-kit.ts";
import { displayText, safeMediaUrl } from "../../_shared/untrusted.ts";
import { isVideoAsset } from "../format.ts";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  CloseIcon,
  PauseIcon,
  PlayIcon,
} from "../icons.tsx";
import { isRenderableUri } from "../media.ts";
import type { Asset } from "../types.ts";
import { assetRatio, SLIDESHOW_STATUS } from "../viewer.ts";

import styles from "./Slideshow.module.css";

const ADVANCE_MS = 4000;

export function SlideshowView({
  list,
  startAssetId,
  onClose,
}: {
  list: Asset[];
  startAssetId: string | null;
  onClose: (stoppedOn: Asset | null) => void;
}) {
  const photos = list.filter(
    (a) => isRenderableUri(a.content_uri) && !isVideoAsset(a)
  );
  const startIdx = startAssetId
    ? photos.findIndex((a) => a.asset_id === startAssetId)
    : 0;
  const [idx, setIdx] = useState(Math.max(0, startIdx));
  const [paused, setPaused] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | 0>(0);

  const step = useCallback(
    (delta: number) => {
      setIdx((i) => {
        const n = photos.length;
        if (n === 0) return i;
        return (i + delta + n) % n;
      });
    },
    [photos.length]
  );

  const leave = useCallback(
    () => onClose(photos[idx] ?? null),
    [onClose, photos, idx]
  );

  useEffect(() => {
    if (paused || photos.length <= 1) return undefined;
    timerRef.current = setTimeout(() => step(1), ADVANCE_MS);
    return () => clearTimeout(timerRef.current);
  }, [idx, paused, step, photos.length]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        leave();
      } else if (e.key === " ") {
        e.preventDefault();
        setPaused((p) => !p);
      } else if (e.key === "ArrowLeft") {
        step(-1);
      } else if (e.key === "ArrowRight") {
        step(1);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [step, leave]);

  if (photos.length === 0) {
    return (
      <div className={styles.stage}>
        <p className={styles.empty}>
          Nothing here plays as a slideshow — a video is opened on its own, not
          stepped through.
        </p>
        <button type="button" className={styles.exit} onClick={leave}>
          <CloseIcon size={14} /> Close
        </button>
      </div>
    );
  }

  const asset = photos[idx]!;
  const src = safeMediaUrl(asset.content_uri);
  return (
    <div className={styles.stage}>
      {/* No backdrop-shield onClick on the image or the bar: `#slideshow`'s
          native close listener gates on `e.target === e.currentTarget`. */}
      <div className={styles.mediaWrap}>
        <img
          key={`${asset.scope_id ?? ""}:${asset.asset_id}`}
          className={styles.image}
          style={{ aspectRatio: String(assetRatio(asset)) }}
          src={src ?? undefined}
          alt={displayText(asset.title ?? "Photograph")}
          data-scope={scopeAttr(asset.scope_id)}
        />
      </div>
      <button
        type="button"
        className={`${styles.nav} ${styles.navPrev}`}
        aria-label="Previous photograph"
        title="Previous photograph"
        onClick={(e) => {
          e.stopPropagation();
          step(-1);
        }}
      >
        <ChevronLeftIcon size={20} />
      </button>
      <button
        type="button"
        className={`${styles.nav} ${styles.navNext}`}
        aria-label="Next photograph"
        title="Next photograph"
        onClick={(e) => {
          e.stopPropagation();
          step(1);
        }}
      >
        <ChevronRightIcon size={20} />
      </button>

      <div className={styles.foot}>
        {/* ONE transport (§7.3); pause is always present. */}
        <div className={styles.transport}>
          <button
            type="button"
            className={styles.play}
            aria-pressed={paused}
            aria-label={paused ? "Play" : "Pause"}
            title={paused ? "Play" : "Pause"}
            onClick={() => setPaused((p) => !p)}
          >
            {paused ? <PlayIcon size={16} /> : <PauseIcon size={16} />}
          </button>
          {/* Determinate exact counts — never a spinner (§14). */}
          <progress
            className={styles.track}
            aria-label="Position"
            max={photos.length}
            value={idx + 1}
          />
          <span className={styles.position}>
            {idx + 1} / {photos.length}
          </span>
          <button type="button" className={styles.exit} onClick={leave}>
            Exit
          </button>
        </div>
        {/* Status line, inside the stage. Verbatim (§7.3). */}
        <p className={styles.status}>{SLIDESHOW_STATUS}</p>
      </div>
    </div>
  );
}
