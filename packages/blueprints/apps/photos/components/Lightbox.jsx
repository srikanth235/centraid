// The lightbox: stage (image/video/placeholder), nav arrows, and the
// caption/capture-time/albums/faces panel. `refresh` and `onClose` are the
// only app.jsx-owned pieces threaded down as props — every command here
// (caption/capture-time/album-toggle/favorite/delete) fires through `act`
// imported directly from outcomes.js, since none of it touches app.jsx's
// asset/album *lists*, only a single asset by id. `onSlideshow` (issue #352)
// is the one exception threaded through instead: starting a slideshow means
// closing THIS region and opening a different one, which only app.jsx (via
// lightbox.jsx) can do.
import { armConfirm, fmtBytes, toast } from '../kit.js';
import { restoreAsset, toggleFavorite } from '../assets-actions.js';
import { renderFaces } from '../faces.js';
import {
  assetBytes,
  cls,
  exifRows,
  isRenderableUri,
  isVideoAsset,
  toLocalInputValue,
} from '../format.js';
import { act, narrate } from '../outcomes.js';
import { useEffect, useRef, useState } from '../react-core.min.js';

// Double-click zooms the stage image; while zoomed a pointer drag pans it.
function wireZoom(img) {
  let zoomed = false;
  let panX = 0;
  let panY = 0;
  let dragging = false;
  let startX = 0;
  let startY = 0;
  const apply = () => {
    img.style.transform = zoomed ? `translate(${panX}px, ${panY}px) scale(2.5)` : '';
    img.classList.toggle('zoomed', zoomed);
  };
  img.classList.add('zoomable');
  img.addEventListener('dblclick', (e) => {
    e.stopPropagation();
    zoomed = !zoomed;
    panX = 0;
    panY = 0;
    apply();
  });
  img.addEventListener('pointerdown', (e) => {
    if (!zoomed) return;
    dragging = true;
    startX = e.clientX - panX;
    startY = e.clientY - panY;
    img.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  img.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    panX = e.clientX - startX;
    panY = e.clientY - startY;
    apply();
  });
  const stop = () => {
    dragging = false;
  };
  img.addEventListener('pointerup', stop);
  img.addEventListener('pointercancel', stop);
  // A drag while zoomed must not fall through as a backdrop click.
  img.addEventListener('click', (e) => e.stopPropagation());
}

// The stage's media (image/video/placeholder), keyed by `asset_id` where it's
// mounted (LightboxShell, below): stepping to a different photo always mints
// a fresh element (so zoom state never bleeds from one photo to the next),
// while a background refresh landing on the SAME photo reuses the node (so
// the image doesn't reload/flicker) — the same guarantee the Lit port's
// keyed single-item `repeat()` gave the stage. `wireZoom` is guarded per
// element (via the ref's dataset check) so reuse never double-attaches its
// pointer/dblclick listeners; this stays the one genuinely imperative island
// in the lightbox, same as the Lit port.
export function Stage({ asset, onDims }) {
  if (isRenderableUri(asset.content_uri) && isVideoAsset(asset)) {
    return (
      <video
        src={asset.content_uri}
        muted
        playsInline
        controls
        preload="metadata"
        aria-label={asset.title ?? 'Video'}
      ></video>
    );
  }
  if (isRenderableUri(asset.content_uri)) {
    const needsProbe = asset.width == null || asset.height == null;
    return (
      <img
        src={asset.content_uri}
        alt={asset.title ?? asset.kind ?? 'Photo'}
        ref={(el) => {
          if (!el || el.dataset.zoomWired) return;
          el.dataset.zoomWired = '1';
          wireZoom(el);
        }}
        onLoad={(e) => {
          if (needsProbe) onDims(e.target.naturalWidth, e.target.naturalHeight);
        }}
      />
    );
  }
  return <div className="lightbox-placeholder">{asset.media_type ?? asset.kind ?? 'media'}</div>;
}

// The details/EXIF disclosure (issue #352): whatever `exifRows` found —
// captured server-side at upload (packages/vault/src/blob/pipeline.ts) plus
// the always-known dimensions/size/captured-time/type. Degrades to a plain
// sentence when nothing at all is known (an asset with no dimensions, no
// recorded size, no captured time — effectively never happens today, but a
// row with everything null must still render something, not a blank box).
function DetailsPanel({ asset }) {
  const rows = exifRows(asset);
  if (rows.length === 0) {
    return <p className="lightbox-details-empty kit-muted kit-small">No details available.</p>;
  }
  return (
    <dl className="lightbox-details">
      {rows.map((row) => (
        <div className="lightbox-details-row" key={row.label}>
          <dt>{row.label}</dt>
          <dd>
            {row.href ? (
              <a href={row.href} target="_blank" rel="noreferrer">
                {row.value}
              </a>
            ) : (
              row.value
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}

// The lightbox's caption/capture-time form, info line and faces host, keyed
// by `renderSeq` (so every call to `renderLightbox` mints a wholly fresh copy
// of this subtree) — exactly mirroring the Lit port's choice to rebuild these
// as plain nodes on every call, because they're written into by scattered
// async handlers (save, faces confirm/reject, the stage's load-driven
// dimension probe) whose closures are simplest when they close over a
// stable, already-existing element. `setInfoRef` is how the sibling `Stage`
// (which does NOT remount on a same-photo refresh) reaches whichever
// `PanelBody` is currently mounted — its effect refreshes that ref's target
// on every mount, the same way the old code's `setInfo` closure got replaced
// by each `renderLightbox` call even though the stage element itself
// persisted underneath it.
export function PanelBody({ asset, albums: albumList, setInfoRef, refresh, onClose, onSlideshow }) {
  const noteRef = useRef(null);
  const infoRef = useRef(null);
  const facesHostRef = useRef(null);
  const [detailsOpen, setDetailsOpen] = useState(false);

  useEffect(() => {
    setInfoRef.current = (w, h) => {
      const parts = [asset.kind ?? 'photo'];
      const width = asset.width ?? w;
      const height = asset.height ?? h;
      if (width && height) parts.push(`${width}×${height}`);
      const size = fmtBytes(assetBytes(asset));
      if (size) parts.push(size);
      const t = asset.taken_at ? new Date(asset.taken_at) : null;
      if (t && !Number.isNaN(t.getTime())) {
        parts.push(t.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }));
      }
      if (infoRef.current) infoRef.current.textContent = parts.join(' · ');
    };
    setInfoRef.current();
    // People (issue #299): the enricher's face proposals with the owner's
    // confirm/reject loop. Loaded async so an empty vault costs nothing; the
    // section only appears when regions exist.
    renderFaces(facesHostRef.current, asset.asset_id, noteRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- this component
    // remounts fresh on every renderLightbox() call (keyed by renderSeq), so
    // "run once per mount" already means "run once per asset+refresh pass".
  }, []);

  return (
    <>
      <div className="lightbox-meta">
        <input
          type="text"
          className="kit-input lightbox-title"
          defaultValue={asset.title ?? ''}
          placeholder="Add a caption"
          aria-label="Caption"
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur();
          }}
          onChange={async (e) => {
            const title = e.currentTarget.value.trim();
            if (title === (asset.title ?? '')) return;
            const outcome = await act('update-asset', { asset_id: asset.asset_id, title });
            if (narrate(outcome, noteRef.current)) await refresh();
          }}
        />
        <input
          type="datetime-local"
          className="kit-input lightbox-when"
          defaultValue={toLocalInputValue(asset.captured_at ?? asset.taken_at)}
          aria-label="Capture time"
          onChange={async (e) => {
            if (!e.currentTarget.value) return;
            const d = new Date(e.currentTarget.value);
            if (Number.isNaN(d.getTime())) return;
            const outcome = await act('update-asset', {
              asset_id: asset.asset_id,
              captured_at: d.toISOString(),
            });
            if (narrate(outcome, noteRef.current)) await refresh();
          }}
        />
      </div>
      <p className="lightbox-info" ref={infoRef}></p>
      <button
        type="button"
        className="lightbox-details-toggle"
        aria-expanded={detailsOpen ? 'true' : 'false'}
        onClick={() => setDetailsOpen((v) => !v)}
      >
        {detailsOpen ? '▾ Hide details' : '▸ Details'}
      </button>
      {detailsOpen ? <DetailsPanel asset={asset} /> : null}
      {albumList.length > 0 ? (
        <div className="lightbox-albums">
          {albumList.map((album) => {
            const member = asset.album_ids?.includes(album.album_id) ?? false;
            return (
              <button
                key={album.album_id}
                type="button"
                className="kit-chip"
                data-active={member ? 'true' : 'false'}
                onClick={async () => {
                  const outcome = await act(member ? 'remove-from-album' : 'add-to-album', {
                    album_id: album.album_id,
                    asset_id: asset.asset_id,
                  });
                  if (narrate(outcome, noteRef.current)) await refresh();
                }}
              >
                {member ? `✓ ${album.title ?? 'Album'}` : (album.title ?? 'Album')}
              </button>
            );
          })}
        </div>
      ) : null}
      <div className="lightbox-faces" ref={facesHostRef}></div>
      <div className="lightbox-actions">
        <button
          type="button"
          className={cls('kit-btn', 'lightbox-fav', asset.favorite && 'faved')}
          aria-pressed={asset.favorite ? 'true' : 'false'}
          onClick={async () => {
            await toggleFavorite(asset, refresh, noteRef.current); // refresh re-renders this lightbox
          }}
        >
          {asset.favorite ? '♥ Favorited' : '♡ Favorite'}
        </button>
        <button type="button" className="kit-btn" onClick={onSlideshow}>
          ▶ Slideshow
        </button>
        {isRenderableUri(asset.content_uri) ||
        String(asset.content_uri ?? '').startsWith('data:') ? (
          <a
            className="kit-btn lightbox-download"
            href={asset.content_uri}
            download={(asset.title ?? '').trim() || `photo-${asset.asset_id}`}
          >
            Download
          </a>
        ) : null}
        <button
          type="button"
          className="kit-btn danger"
          onClick={async (e) => {
            if (!armConfirm(e.currentTarget, { armedLabel: 'Delete photo?' })) return;
            const outcome = await act('delete-asset', { asset_id: asset.asset_id });
            if (narrate(outcome, noteRef.current)) {
              onClose();
              toast('Moved to trash — it leaves every album it was in.', {
                undoLabel: 'Undo',
                onUndo: () => restoreAsset(asset.asset_id, refresh),
              });
              await refresh();
            }
          }}
        >
          Delete photo
        </button>
      </div>
      <p className="lightbox-note" ref={noteRef}></p>
    </>
  );
}

// The lightbox shell itself never remounts while open — only its two
// independently keyed children do (Stage by asset_id, PanelBody by
// renderSeq) — so `setInfoRef` (a plain ref holding "whatever PanelBody's
// current setInfo function is") survives across both stepping and refreshing.
export function LightboxShell({
  asset,
  idx,
  list,
  albums: albumList,
  renderSeq,
  onStep,
  refresh,
  onClose,
  onSlideshow,
}) {
  const setInfoRef = useRef(() => {});
  return (
    <>
      <div className="lightbox-stage" onClick={(e) => e.stopPropagation()}>
        <Stage key={asset.asset_id} asset={asset} onDims={(w, h) => setInfoRef.current(w, h)} />
      </div>
      {[
        ['prev', -1, '‹', 'Previous photo'],
        ['next', 1, '›', 'Next photo'],
      ].map(([variant, delta, glyph, name]) => (
        <button
          key={variant}
          type="button"
          className={`kit-viewer-nav ${variant}`}
          aria-label={name}
          disabled={idx < 0 || !list[idx + delta]}
          onClick={(e) => {
            e.stopPropagation();
            onStep(delta);
          }}
        >
          {glyph}
        </button>
      ))}
      <div className="lightbox-panel" onClick={(e) => e.stopPropagation()}>
        <PanelBody
          key={renderSeq}
          asset={asset}
          albums={albumList}
          setInfoRef={setInfoRef}
          refresh={refresh}
          onClose={onClose}
          onSlideshow={onSlideshow}
        />
      </div>
    </>
  );
}
