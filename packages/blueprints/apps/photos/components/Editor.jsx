// Crop/rotate editor (issue #352 phase 3/4). Non-destructive by design: the
// vault has no media-domain equivalent of core.replace_document_content (no
// "edit an asset's bytes in place" command exists — see this app's report
// for that gap), so an edit can only ever mint a NEW asset over the edited
// bytes through the existing `upload` action; the original stays untouched
// in the library unless the owner explicitly checks "Also move the original
// to trash". Rendering happens entirely client-side on a <canvas> (the same
// raster codec upload.js's thumb pipeline already uses) — rotation redraws
// the whole frame, crop is a drag-anywhere-to-redraw rectangle (no resize
// handles; redrawing replaces the previous rectangle) in fractions of the
// CURRENT rotated frame, so it always lines up with what's on screen.
import { stageFileBytes, toast } from '../kit.js';
import { act, narrate } from '../outcomes.js';
import { useEffect, useRef, useState } from '../react-core.min.js';

function clamp01(n) {
  return Math.max(0, Math.min(1, n));
}

// A NEW canvas holding only the fractional `crop` region of `source`.
function cropCanvas(source, crop) {
  const sx = Math.round(crop.x * source.width);
  const sy = Math.round(crop.y * source.height);
  const sw = Math.max(1, Math.round(crop.w * source.width));
  const sh = Math.max(1, Math.round(crop.h * source.height));
  const out = document.createElement('canvas');
  out.width = sw;
  out.height = sh;
  out.getContext('2d').drawImage(source, sx, sy, sw, sh, 0, 0, sw, sh);
  return out;
}

export function EditorView({ asset, onCancel, onSaved, refresh }) {
  const [rotation, setRotation] = useState(0);
  const [crop, setCrop] = useState(null);
  const [busy, setBusy] = useState(false);
  const [alsoTrash, setAlsoTrash] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const canvasRef = useRef(null);
  const imgRef = useRef(null);
  const dragRef = useRef(null);
  const noteRef = useRef(null);

  function draw() {
    const img = imgRef.current;
    const canvas = canvasRef.current;
    if (!img || !canvas) return;
    const swapped = rotation % 180 !== 0;
    const w = swapped ? img.naturalHeight : img.naturalWidth;
    const h = swapped ? img.naturalWidth : img.naturalHeight;
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.save();
    ctx.translate(w / 2, h / 2);
    ctx.rotate((rotation * Math.PI) / 180);
    ctx.drawImage(img, -img.naturalWidth / 2, -img.naturalHeight / 2);
    ctx.restore();
  }

  // One source Image per mount — content_uri never changes under an open
  // editor (the lightbox mints a fresh EditorView per asset via its own
  // remount contract), so this loads exactly once.
  useEffect(() => {
    let cancelled = false;
    const img = new Image();
    img.onload = () => {
      if (cancelled) return;
      imgRef.current = img;
      draw();
    };
    img.onerror = () => {
      if (!cancelled) setLoadError(true);
    };
    img.src = asset.content_uri;
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one-shot load; the rotation-driven redraw is the effect below
  }, []);

  useEffect(() => {
    draw();
    setCrop(null); // a rectangle drawn against the OLD orientation no longer lines up
    // eslint-disable-next-line react-hooks/exhaustive-deps -- draw() closes over the current rotation/refs each render
  }, [rotation]);

  function fractionAt(e) {
    const rect = canvasRef.current.getBoundingClientRect();
    return {
      x: clamp01((e.clientX - rect.left) / rect.width),
      y: clamp01((e.clientY - rect.top) / rect.height),
    };
  }

  function onPointerDown(e) {
    if (!canvasRef.current) return;
    const start = fractionAt(e);
    dragRef.current = start;
    e.currentTarget.setPointerCapture(e.pointerId);
    setCrop({ x: start.x, y: start.y, w: 0, h: 0 });
  }
  function onPointerMove(e) {
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

  async function handleSave() {
    const canvas = canvasRef.current;
    if (!canvas || !imgRef.current) return;
    setBusy(true);
    try {
      const source = crop ? cropCanvas(canvas, crop) : canvas;
      const blob = await new Promise((resolve) => source.toBlob(resolve, 'image/jpeg', 0.92));
      if (!blob) throw new Error('Could not render the edit.');
      const baseName = (asset.title || 'photo').replace(/\.[a-z0-9]+$/i, '');
      const file = new File([blob], `${baseName}-edited.jpg`, { type: 'image/jpeg' });
      const staged = await stageFileBytes(file);
      const outcome = await act('upload', {
        staged_sha: staged.sha256,
        kind: 'photo',
        captured_at: asset.captured_at || asset.taken_at || new Date().toISOString(),
        title: asset.title || 'Edited photo',
        width: source.width,
        height: source.height,
      });
      if (!narrate(outcome, noteRef.current)) return;
      if (alsoTrash) await act('delete-asset', { asset_id: asset.asset_id });
      toast('Saved as a new photo — the original is untouched.');
      await refresh();
      onSaved();
    } catch (err) {
      if (noteRef.current) noteRef.current.textContent = String(err?.message ?? err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="editor">
      <div
        className="editor-canvas-wrap"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        {loadError ? (
          <p className="kit-muted editor-load-error">Could not load this photo for editing.</p>
        ) : (
          <canvas ref={canvasRef} className="editor-canvas" />
        )}
        {crop ? (
          <div
            className="editor-crop-box"
            style={{
              left: `${crop.x * 100}%`,
              top: `${crop.y * 100}%`,
              width: `${crop.w * 100}%`,
              height: `${crop.h * 100}%`,
            }}
          />
        ) : null}
      </div>
      <div className="editor-toolbar">
        <button
          type="button"
          className="kit-btn"
          disabled={busy}
          onClick={() => setRotation((r) => (r + 90) % 360)}
        >
          ⟳ Rotate
        </button>
        <button
          type="button"
          className="kit-btn"
          disabled={busy || !crop}
          onClick={() => setCrop(null)}
        >
          Reset crop
        </button>
        <label className="editor-trash-toggle">
          <input
            type="checkbox"
            checked={alsoTrash}
            disabled={busy}
            onChange={(e) => setAlsoTrash(e.currentTarget.checked)}
          />
          Also move the original to trash
        </label>
        <span className="editor-spacer" />
        <button type="button" className="kit-btn" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="kit-btn primary" disabled={busy} onClick={handleSave}>
          {busy ? 'Saving…' : 'Save as new photo'}
        </button>
      </div>
      <p className="lightbox-note editor-note" ref={noteRef}></p>
      <p className="kit-muted kit-small editor-hint">
        Drag on the photo to crop. The original stays in your library unless you check “Also move
        the original to trash.”
      </p>
    </div>
  );
}
