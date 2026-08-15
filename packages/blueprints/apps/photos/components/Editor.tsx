// The editor (v4 handoff §7.4) — NON-DESTRUCTIVE, AND LEGIBLE ABOUT IT.
//
// Crop and rotate only. Not a reduced feature set awaiting filters: an edit
// this app cannot express as "a new photograph beside the original" is an edit
// it does not offer, because the alternative is overwriting bytes the member
// cannot get back.
//
// The commit is worded as what it DOES — `Save as a new photograph` — and it
// is the ONE filled ink element in this view (§18). The sentence explaining
// that the original is untouched sits BESIDE it, at the point of decision,
// rather than in a confirmation afterwards: a member deciding whether to press
// a button needs the consequence before the press, not after it.
//
// There is deliberately no "also move the original to trash" here any more.
// The commit's own copy promises "The original is not touched, and nothing is
// overwritten"; a checkbox that trashes it in the same gesture makes that
// sentence false.
//
// Rendering is entirely client-side on a <canvas> — the same raster path
// upload.ts's thumb pipeline uses. Rotation redraws the whole frame at the
// total angle (90° steps plus straighten) into its rotated bounding box; crop
// is a drag-anywhere rectangle in fractions of the CURRENT frame, so it always
// lines up with what is on screen.
import { useCallback, useEffect, useRef, useState } from "react";
import type { PointerEvent } from "react";

import { isPendingOffsite, stageFileBytes } from "@centraid/design/elements";

import { safeMediaUrl } from "../../_shared/untrusted.ts";
import { BLOB_PENDING_ATTR } from "../media-observer.ts";
import { act, narrate, notice } from "../outcomes.ts";
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

/** How far one press of Straighten turns the frame. Small enough that the
 *  control is for levelling a horizon, not for rotating a photograph — that
 *  is what Rotate 90° is for. */
const STRAIGHTEN_STEP = 1;
const STRAIGHTEN_LIMIT = 15;

/** The rectangle `Crop` starts from: centred, inset a tenth on every side, so
 *  there is something to drag before a drag has happened. Cropping used to be
 *  reachable ONLY by dragging across the canvas, which is no control at all on
 *  a keyboard — the handoff lists `Crop` among the tool row's buttons
 *  (proto 4621), and this is what pressing it does. */
const DEFAULT_CROP: Crop = { x: 0.1, y: 0.1, w: 0.8, h: 0.8 };

/** A tool label as the handoff writes it (proto 4621, 4624): `3 : 2` carries
 *  spaces, and every label with a `:` or a `°` in it is set in MONO — the
 *  numeric register, because those labels ARE numbers. `EDITOR_RATIOS` keeps
 *  its unspaced ids (viewer.ts owns them, and they are compared, not read). */
function ratioLabel(ratio: EditorRatio): string {
  return ratio === "3:2" ? "3 : 2" : ratio;
}

/** Does this label read as a number (and so take the mono face)? */
function isNumericLabel(label: string): boolean {
  return label.includes(":") || label.includes("°");
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

/** A NEW canvas holding only the fractional `crop` region of `source`. */
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

/** The bounding box a `w × h` frame occupies once turned by `deg`. Straighten
 *  is not a multiple of 90°, so the box grows rather than merely swapping. */
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
    // The source is a MOUNTED element now, so it exists from the first render
    // — before it holds any pixels. `naturalWidth` is the load's own signal,
    // and drawing without it would size the canvas from a 0×0 frame.
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
    // A near-zero-area drag (an accidental tap) discards itself rather than
    // leaving a sliver crop nobody meant to draw.
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
      // A new photograph lands beside the original, so it lands in the
      // ORIGINAL's scope (issue #599) — never in the chip selection, which
      // could be a different audience entirely.
      const scope = asset.scope_id ?? undefined;
      const staged = await stageFileBytes(file, "", scope ? { scope } : {});
      const outcome = await act(
        "upload",
        {
          staged_sha: staged.sha256,
          kind: "photo",
          // Both halves of what the commit's sentence promises (issue #711):
          // dated TODAY, and "with this one recorded as its source" — which is
          // now a real column (`media_asset.source_asset_id`) rather
          // than a claim with nowhere to land. The lineage is what lets the
          // editor's own meta line say where an edited copy came from instead
          // of reading its save date back as a capture date.
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
          : "Saved as a new photograph — the original is not touched."
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
    // `data-editor="open"` is how the ORCHESTRATOR knows an edit is in
    // progress (lightbox.tsx `isEditing`) without a second copy of this
    // component's state living somewhere it can go stale. It is what stops
    // ←/→ from stepping the viewer out from under an unsaved crop.
    <div className={styles.editor} data-editor="open">
      {/* THE SOURCE IS PAINTED THROUGH THE DOM, NOT THROUGH `new Image()`.
          A `/centraid/_vault/blobs/…` path carries no credential on its own.
          Inline — the shell document, and desktop's `file://` — it is not the
          gateway at all: it falls through to the SPA's own index.html, the
          element receives HTML and fires `error`. What makes it load is the
          shell's authorizer (`inline-blob-images.ts`), a MutationObserver over
          the mounted app subtree that swaps each blob reference for an authed
          `blob:` object URL. A detached `new Image()` is in no subtree, so no
          observer ever saw it and every edit opened on the failure copy.

          `BLOB_PENDING_ATTR` is the other half of that contract: while an
          authorization is in flight the stamp is set, and an `error` under it
          is not a verdict — it is the raw path failing before the swap lands.
          The authorizer re-fires `error` once it gives up for real, with the
          stamp cleared, which is the branch below that ends in `loadError`. */}
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
            This photograph could not be opened for editing. Its record is
            untouched, and nothing has been written.
          </p>
        ) : (
          <canvas ref={canvasRef} className={styles.canvas} />
        )}
        {crop ? (
          // A 1px rectangle, everything outside it dimmed by one enormous
          // shadow, and a dashed thirds grid inside (§7.4). The mask colour is
          // the stage at 55% — the handoff's own `rgba(11,11,11,.55)`, said in
          // the token that owns that value.
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

      {/* ONE WRAPPING BAR (proto 4617-4630): the tools, the sentence that
          explains the commit, and the commit itself are the same row, wrapping
          together. They were two stacked rows, which put the explanation and
          the button it explains on opposite sides of a rule — the sentence is
          only doing its job at the POINT OF DECISION. */}
      <div className={styles.editBar}>
        <div className={styles.tools} role="toolbar" aria-label="Edit">
          {/* `Crop` is a BUTTON, not a label over a gesture (proto 4621). It
              was a `<span>`, which meant the only way to crop anything was to
              drag across the canvas — nothing at all on a keyboard. */}
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
              // A rectangle drawn against the OLD orientation no longer lines
              // up. Cleared here, with the rotation, rather than from the
              // redraw effect — rotating is the only thing that invalidates a
              // crop.
              setCrop(null);
              setRatio("Original");
            }}
          >
            Rotate 90°
          </button>

          {/* STRAIGHTEN IS BUTTONS (proto 4621), not a label plus a −/+
              stepper with a readout beside it — that stepper was invented
              here, and its readout duplicated a number the stage's own status
              line is supposed to carry (`rotation −2°`, proto 4643). Two
              buttons rather than the prototype's frozen one, because a horizon
              tilts both ways; the live total rides their accessible names, so
              nothing is lost while the status line is out of this component's
              reach. */}
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

        {/* Cancel THEN Save (proto 2891-2906): the way back stands before the
            commit, and the commit is the last thing in the row. */}
        <div className={styles.commitActions}>
          <button
            type="button"
            className={styles.tool}
            // The key handler cancels an edit THROUGH this button
            // (lightbox.tsx `cancelEdit`), so Escape and a click can never
            // mean two different things.
            data-editor-cancel=""
            disabled={busy}
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            type="button"
            // The ONE filled ink element in this view — and a DISABLED commit
            // is never filled (§18), which the stylesheet enforces on the same
            // class rather than by swapping it.
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
