// The slideshow (v4 handoff §7.3) — A DIFFERENT MODE FROM THE VIEWER, not the
// viewer with its chrome hidden.
//
// What it does not have is the point: no filmstrip, no info panel, no action
// bar. One transport, a determinate position (`12` / `184`), and a status line
// that says what leaving does — because the one thing a member wonders while a
// slideshow runs is whether stopping loses their place. It does not: the
// viewer keeps the photograph they stopped on, and this says so rather than
// making them find out.
//
// It stands on the same STAGE as the viewer and the editor: `--stage` in both
// themes, ink `--on-stage`, hairlines `--stage-line`. The wrapper below paints
// it edge to edge inside the host container, so the stage covers the whole
// frame here exactly as it does in the viewer.
//
// Videos are skipped, during auto-advance and manual stepping alike: there is
// no reliable "finished playing" signal to hang the 4s timer off, and a
// silently autoplaying video would need a mute/sound decision this app does
// not otherwise make. Open a video from the grid or the viewer to play it.
import { useCallback, useEffect, useRef, useState } from "react";

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
import { scopeAttr } from "../scopes.ts";
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
  /** Carries the photograph the run stopped on, so the viewer can reopen
   *  there — which is what the status line promises (§7.3). */
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

  // Escape and the Exit button agree on where the run stopped because both go
  // through here, and it reads the CURRENT index off the render that closed —
  // never a ref written during render, which React may discard.
  const leave = useCallback(
    () => onClose(photos[idx] ?? null),
    [onClose, photos, idx]
  );

  // Re-arms the 4s clock on every idx/paused change — a manual step resets the
  // wait, which is the behaviour a slideshow remote would give you too.
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
          native close listener already gates on `e.target === e.currentTarget`
          (see slideshow.tsx), so a click on either never reached it. */}
      <div className={styles.mediaWrap}>
        <img
          key={`${asset.scope_id ?? ""}:${asset.asset_id}`}
          className={styles.image}
          style={{ aspectRatio: String(assetRatio(asset)) }}
          src={src ?? undefined}
          alt={displayText(asset.title ?? "Photograph")}
          /* A run steps through the merged list, so consecutive slides can
             come from different scopes; each names its own (issue #599). */
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
        {/* ONE transport (§7.3). The pause control is always present — a run
            you cannot stop is not a control, it is an animation. */}
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
          {/* Determinate, with exact counts — never a spinner (§14). A real
              `<progress>`, so the indeterminate state is not expressible. */}
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
        {/* The status line, inside the stage. It answers the one question a
            running slideshow raises. Verbatim (§7.3). */}
        <p className={styles.status}>{SLIDESHOW_STATUS}</p>
      </div>
    </div>
  );
}
