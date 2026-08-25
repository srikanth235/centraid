// Editor (§7.4) — non-destructive. Crop and rotate only; commit is a new
// photograph beside the original. No "also trash the original" — that would
// falsify the copy. Consequence sits BESIDE the one filled commit (§18).
// Canvas raster; crop is fractions of the CURRENT frame.
import { useCallback, useEffect, useRef, useState } from "react";
import type { PointerEvent } from "react";

import { isPendingOffsite, stageFileBytes } from "@centraid/design/elements";

import { safeMediaUrl } from "../../_shared/untrusted.ts";
import { BLOB_PENDING_ATTR } from "../media-observer.ts";
import { act, narrate, notice } from "../outcomes.ts";
import { PHOTOS_SAVED_AS_NEW } from "../shared-copy.ts";
import type { Asset } from "../types.ts";
import {
  centredCrop,
  EDITOR_RATIOS,
  ratioValue,
  SAVE_AS_NEW,
  SAVE_AS_NEW_EXPLANATION,
} from "../viewer.ts";
import type { EditorRatio } from "../viewer.ts";

import styles from "./Editor.module.css";

interface Crop {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Horizon levelling, not rotation — that's Rotate 90°. */
const STRAIGHTEN_STEP = 1;
const STRAIGHTEN_LIMIT = 15;

/** Keyboard-reachable Crop (proto 4621): centred inset, not drag-only. */
const DEFAULT_CROP: Crop = { x: 0.1, y: 0.1, w: 0.8, h: 0.8 };

/** Display label: `3 : 2` spaced; ids stay unspaced for comparison. */
function ratioLabel(ratio: EditorRatio): string {
  return ratio === "3:2" ? "3 : 2" : ratio;
}

function isNumericLabel(label: string): boolean {
  return label.includes(":") || label.includes("°");
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

function cropCanvas(source: HTMLCanvasElement, crop: Crop): HTMLCanvasElement {
  const sx = Math.round(crop.x * source.width);
  const sy = Math.round(crop.y * source.height);
  const sw = Math.max(1, Math.round(crop.w * source.width));
  const sh = Math.max(1, Math.round(crop.h * source.height));
  const out = document.createElement("canvas");
  out.width = sw;
  out.height = sh;
  out.getContext("2d")!.drawImage(source, sx, sy, sw, sh, 0, 0, sw, sh);
  return out;
}

/** Bounding box after `deg`. Straighten is not 90°, so the box grows. */
function rotatedBox(
  w: number,
  h: number,
  deg: number
): { width: number; height: number } {
  const rad = (deg * Math.PI) / 180;
  const cos = Math.abs(Math.cos(rad));
  const sin = Math.abs(Math.sin(rad));
  return {
    width: Math.max(1, Math.round(w * cos + h * sin)),
    height: Math.max(1, Math.round(w * sin + h * cos)),
  };
}

export function EditorView({
  asset,
  onCancel,
  onSaved,
  refresh,
}: {
  asset: Asset;
  onCancel: () => void;
  onSaved: () => void;
  refresh: () => Promise<void>;
}) {
  const [quarters, setQuarters] = useState(0);
  const [straighten, setStraighten] = useState(0);
  const [crop, setCrop] = useState<Crop | null>(null);
  const [ratio, setRatio] = useState<EditorRatio>("Original");
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const dragRef = useRef<{ x: number; y: number } | null>(null);

  const angle = quarters * 90 + straighten;

  const draw = useCallback(() => {
    const img = imgRef.current;
    const canvas = canvasRef.current;
    if (!img || !canvas) return;
    // Mounted before it has pixels — wait for `naturalWidth` or the canvas is 0×0.
    if (!img.complete || img.naturalWidth === 0) return;
    const box = rotatedBox(img.naturalWidth, img.naturalHeight, angle);
    canvas.width = box.width;
    canvas.height = box.height;
    const ctx = canvas.getContext("2d")!;
    ctx.save();
    ctx.translate(box.width / 2, box.height / 2);
    ctx.rotate((angle * Math.PI) / 180);
    ctx.drawImage(img, -img.naturalWidth / 2, -img.naturalHeight / 2);
    ctx.restore();
  }, [angle]);
  const drawRef = useRef(draw);
  useEffect(() => {
    drawRef.current = draw;
  }, [draw]);

  useEffect(() => {
    draw();
  }, [draw]);

  function frameRatio(): number {
    const canvas = canvasRef.current;
    return canvas && canvas.height > 0 ? canvas.width / canvas.height : 1;
  }

  function fractionAt(e: { clientX: number; clientY: number }) {
    const rect = canvasRef.current!.getBoundingClientRect();
    return {
      x: clamp01((e.clientX - rect.left) / rect.width),
      y: clamp01((e.clientY - rect.top) / rect.height),
    };
  }

  function onPointerDown(e: PointerEvent<HTMLDivElement>) {
    if (!canvasRef.current) return;
    const start = fractionAt(e);
    dragRef.current = start;
    e.currentTarget.setPointerCapture(e.pointerId);
    setRatio("Original");
    setCrop({ x: start.x, y: start.y, w: 0, h: 0 });
  }
  function onPointerMove(e: PointerEvent<HTMLDivElement>) {
    if (!dragRef.current) return;
    const cur = fractionAt(e);
    const { x: sx, y: sy } = dragRef.current;
    setCrop({
      x: Math.min(sx, cur.x),
      y: Math.min(sy, cur.y),
      w: Math.abs(cur.x - sx),
      h: Math.abs(cur.y - sy),
    });
  }
  function onPointerUp() {
    dragRef.current = null;
    // Accidental tap: discard a sliver crop.
    setCrop((c) => (c && c.w > 0.02 && c.h > 0.02 ? c : null));
  }

  function chooseRatio(next: EditorRatio) {
    setRatio(next);
    const value = ratioValue(next);
    setCrop(value === null ? null : centredCrop(frameRatio(), value));
  }

  function reset() {
    setQuarters(0);
    setStraighten(0);
    setCrop(null);
    setRatio("Original");
  }

  async function handleSave() {
    const canvas = canvasRef.current;
    if (!canvas || !imgRef.current) return;
    setBusy(true);
    try {
      const source = crop ? cropCanvas(canvas, crop) : canvas;
      const blob = await new Promise<Blob | null>((resolve) => {
        source.toBlob(resolve, "image/jpeg", 0.92);
      });
      if (!blob) throw new Error("The edit could not be rendered.");
      const baseName = (asset.title || "photograph").replace(
        /\.[a-z0-9]+$/iu,
        ""
      );
      const file = new File([blob], `${baseName}-edited.jpg`, {
        type: "image/jpeg",
      });
      // New photo lands in the ORIGINAL's scope (#599), never the chip selection.
      const scope = asset.scope_id ?? undefined;
      const staged = await stageFileBytes(file, "", scope ? { scope } : {});
      const outcome = await act(
        "upload",
        {
          staged_sha: staged.sha256,
          kind: "photo",
          // Dated today + `source_asset_id` (#711) — else meta reads save as capture.
          captured_at: new Date().toISOString(),
          source_asset_id: asset.asset_id,
          title: asset.title || "Edited photograph",
          width: source.width,
          height: source.height,
        },
        scope
      );
      if (!narrate(outcome)) return;
      notice(
        isPendingOffsite(staged)
          ? "Saved as a new photograph · not copied off this device yet."
          : PHOTOS_SAVED_AS_NEW
      );
      await refresh();
      onSaved();
    } catch (error) {
      notice(String((error as { message?: string })?.message ?? error));
    } finally {
      setBusy(false);
    }
  }

  const edited = quarters !== 0 || straighten !== 0 || crop !== null;

  const straightenLabel = `Straighten ${straighten > 0 ? `+${straighten}` : straighten}°`;

  return (
    // `data-editor="open"` is lightbox `isEditing` — stops ←/→ under an unsaved crop.
    <div className={styles.editor} data-editor="open">
      {/* Paint through the DOM, not `new Image()`. Blob paths have no credential;
          the shell authorizer (`inline-blob-images.ts`) swaps mounted subtree
          refs for authed `blob:` URLs. Detached images never get that swap.
          `error` under `BLOB_PENDING_ATTR` is not a verdict — wait for the swap
          or a re-fired error with the stamp cleared. */}
      <img
        ref={imgRef}
        className={styles.source}
        src={safeMediaUrl(asset.content_uri) ?? ""}
        alt=""
        aria-hidden="true"
        decoding="async"
        onLoad={() => {
          setLoadError(false);
          drawRef.current();
        }}
        onError={(e) => {
          if (e.currentTarget.getAttribute(BLOB_PENDING_ATTR) !== "1")
            setLoadError(true);
        }}
      />
      <div
        className={styles.canvasWrap}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        {loadError ? (
          <p className={styles.loadError}>
            This photograph could not be opened for editing.
          </p>
        ) : (
          <canvas ref={canvasRef} className={styles.canvas} />
        )}
        {crop ? (
          // 1px rectangle; outside dimmed; mask is the stage token at 55% (§7.4).
          <div
            className={styles.cropBox}
            style={{
              insetInlineStart: `${crop.x * 100}%`,
              insetBlockStart: `${crop.y * 100}%`,
              inlineSize: `${crop.w * 100}%`,
              blockSize: `${crop.h * 100}%`,
            }}
          />
        ) : null}
      </div>

      {/* One wrapping bar: tools, explanation, and commit at the point of decision. */}
      <div className={styles.editBar}>
        <div className={styles.tools} role="toolbar" aria-label="Edit">
          {/* Crop is a button (proto 4621) — not a drag-only gesture. */}
          <button
            type="button"
            className={styles.tool}
            aria-pressed={crop !== null}
            disabled={busy}
            onClick={() => {
              setRatio("Original");
              setCrop((c) => (c === null ? DEFAULT_CROP : null));
            }}
          >
            Crop
          </button>
          <button
            type="button"
            className={`${styles.tool} ${styles.numeric}`}
            disabled={busy}
            onClick={() => {
              setQuarters((q) => (q + 1) % 4);
              // Old-orientation crop no longer lines up. Clear here, not in redraw.
              setCrop(null);
              setRatio("Original");
            }}
          >
            Rotate 90°
          </button>

          {/* Straighten is two buttons (proto 4621); live total rides aria-label. */}
          <button
            type="button"
            className={`${styles.tool} ${styles.numeric}`}
            aria-label={`Straighten anticlockwise · ${straightenLabel}`}
            disabled={busy || straighten <= -STRAIGHTEN_LIMIT}
            onClick={() => setStraighten((s) => s - STRAIGHTEN_STEP)}
          >
            {`Straighten −${STRAIGHTEN_STEP}°`}
          </button>
          <button
            type="button"
            className={`${styles.tool} ${styles.numeric}`}
            aria-label={`Straighten clockwise · ${straightenLabel}`}
            disabled={busy || straighten >= STRAIGHTEN_LIMIT}
            onClick={() => setStraighten((s) => s + STRAIGHTEN_STEP)}
          >
            {`Straighten +${STRAIGHTEN_STEP}°`}
          </button>

          <fieldset className={styles.ratios}>
            <legend className="kit-sr-only">Crop ratio</legend>
            {EDITOR_RATIOS.map((name) => (
              <button
                key={name}
                type="button"
                className={`${styles.tool} ${isNumericLabel(ratioLabel(name)) ? styles.numeric : ""}`}
                aria-pressed={ratio === name}
                disabled={busy}
                onClick={() => chooseRatio(name)}
              >
                {ratioLabel(name)}
              </button>
            ))}
          </fieldset>

          <button
            type="button"
            className={styles.tool}
            disabled={busy || !edited}
            onClick={reset}
          >
            Reset
          </button>
        </div>

        <p className={styles.explanation}>{SAVE_AS_NEW_EXPLANATION}</p>

        {/* Cancel then Save (proto 2891-2906): way back before the commit. */}
        <div className={styles.commitActions}>
          <button
            type="button"
            className={styles.tool}
            // lightbox `cancelEdit` clicks this — Escape and click stay one act.
            data-editor-cancel=""
            disabled={busy}
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            type="button"
            // One filled ink; disabled is never filled (§18) — stylesheet, same class.
            className={styles.commit}
            disabled={busy || loadError}
            onClick={() => void handleSave()}
          >
            {SAVE_AS_NEW}
          </button>
        </div>
      </div>
    </div>
  );
}
