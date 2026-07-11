// The redesigned lightbox: near-black stage with prev/next arrows and a
// bottom filmstrip, a top bar of icon actions, and the info panel (split out
// to LightboxInfo.jsx — see its header comment). `refresh`/`onClose` are the
// only app.jsx-owned pieces threaded down; every command fires through `act`
// (outcomes.js) directly, same contract as before. `onSlideshow`/`onEdit`
// swap this region for a different one (slideshow.jsx / this file's own
// EditorView), which only the shell here can do.
import { toast } from '../kit.js';
import { toggleFavorite } from '../assets-actions.js';
import { EditorView } from './Editor.jsx';
import { LightboxInfo } from './LightboxInfo.jsx';
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  CloseIcon,
  DownloadIcon,
  EditIcon,
  HeartIcon,
  InfoIcon,
  PlayIcon,
  ShareIcon,
  TrashIcon,
} from '../icons.jsx';
import { fmtBytes } from '../kit.js';
import { assetBytes, isRenderableUri, isVideoAsset } from '../format.js';
import { act, narrate } from '../outcomes.js';
import { useEffect, useState } from '../react-core.min.js';

function withProbedDims(asset, probed) {
  return probed && asset.width == null && asset.height == null ? { ...asset, ...probed } : asset;
}

// Double-click zooms the stage image; while zoomed a pointer drag pans it —
// unchanged from the pre-redesign lightbox, just re-hosted here.
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
  img.addEventListener('click', (e) => e.stopPropagation());
}

// `onDims` fires once, on load, only when the asset row itself carries no
// width/height (an older upload, or a codec this vault's minimal EXIF walk
// didn't probe) — the same "derive it from the live image" fallback the
// pre-redesign lightbox had, just re-hosted here instead of behind a
// PanelBody-owned ref.
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
  return <div className="ph-lb-placeholder">{asset.media_type ?? asset.kind ?? 'media'}</div>;
}

function dateLine(asset) {
  const t = asset.taken_at ? new Date(asset.taken_at) : null;
  const when =
    t && !Number.isNaN(t.getTime())
      ? t.toLocaleString(undefined, { dateStyle: 'full', timeStyle: 'short' })
      : null;
  return [when, asset.place?.name].filter(Boolean).join(' · ') || fmtBytes(assetBytes(asset));
}

async function handleShare(asset) {
  const url =
    typeof asset.content_uri === 'string' && asset.content_uri.startsWith('data:')
      ? location.href
      : asset.content_uri;
  if (navigator.share) {
    try {
      await navigator.share({ title: asset.title ?? 'Photo', url });
      return;
    } catch {
      return; // the user cancelled the native share sheet — not an error
    }
  }
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(url);
      toast('Link copied.');
      return;
    } catch {
      /* fall through */
    }
  }
  toast('Sharing isn’t available in this browser.');
}

export function LightboxShell({
  asset,
  idx,
  list,
  albums: albumList,
  places,
  renderSeq,
  onStep,
  refresh,
  onClose,
  onSlideshow,
}) {
  const [editing, setEditing] = useState(false);
  const [infoOpen, setInfoOpen] = useState(true);
  const [probed, setProbed] = useState(null);
  useEffect(() => setProbed(null), [asset.asset_id]);
  const displayAsset = withProbedDims(asset, probed);
  return (
    <div className="ph-lightbox">
      <div className="ph-lb-topbar">
        <button type="button" className="ph-lb-icon-btn" aria-label="Close" onClick={onClose}>
          <CloseIcon />
        </button>
        <div className="ph-lb-heading">
          <div className="ph-lb-title">{asset.title || asset.place?.name || 'Photo'}</div>
          <div className="ph-lb-dateline">{dateLine(displayAsset)}</div>
        </div>
        {!editing ? (
          <>
            <button
              type="button"
              className="ph-lb-icon-btn"
              data-active={asset.favorite ? 'true' : 'false'}
              aria-pressed={asset.favorite ? 'true' : 'false'}
              aria-label={asset.favorite ? 'Remove from favorites' : 'Add to favorites'}
              onClick={() => toggleFavorite(asset, refresh)}
            >
              <HeartIcon filled={!!asset.favorite} />
            </button>
            <button
              type="button"
              className="ph-lb-icon-btn"
              aria-label="Slideshow"
              onClick={onSlideshow}
            >
              <PlayIcon />
            </button>
            {isRenderableUri(asset.content_uri) && !isVideoAsset(asset) ? (
              <button
                type="button"
                className="ph-lb-icon-btn"
                aria-label="Edit"
                onClick={() => setEditing(true)}
              >
                <EditIcon />
              </button>
            ) : null}
            {isRenderableUri(asset.content_uri) ||
            String(asset.content_uri ?? '').startsWith('data:') ? (
              <a
                className="ph-lb-icon-btn"
                aria-label="Download"
                href={asset.content_uri}
                download={(asset.title ?? '').trim() || `photo-${asset.asset_id}`}
              >
                <DownloadIcon />
              </a>
            ) : null}
            <button
              type="button"
              className="ph-lb-icon-btn"
              aria-label="Share"
              onClick={() => handleShare(asset)}
            >
              <ShareIcon />
            </button>
            <button
              type="button"
              className="ph-lb-icon-btn"
              aria-label="Delete"
              onClick={async () => {
                const outcome = await act('delete-asset', { asset_id: asset.asset_id });
                if (narrate(outcome)) {
                  onClose();
                  toast('Moved to trash — it leaves every album it was in.', {
                    undoLabel: 'Undo',
                    onUndo: async () => {
                      await act('restore', { asset_id: asset.asset_id });
                      await refresh();
                    },
                  });
                  await refresh();
                }
              }}
            >
              <TrashIcon />
            </button>
            <button
              type="button"
              className="ph-lb-icon-btn"
              data-active={infoOpen ? 'true' : 'false'}
              aria-pressed={infoOpen ? 'true' : 'false'}
              aria-label="Info"
              onClick={() => setInfoOpen((v) => !v)}
            >
              <InfoIcon />
            </button>
          </>
        ) : null}
      </div>

      <div className="ph-lb-body">
        <div className="ph-lb-stagewrap" onClick={(e) => e.stopPropagation()}>
          {editing ? (
            <EditorView
              key={asset.asset_id}
              asset={asset}
              refresh={refresh}
              onCancel={() => setEditing(false)}
              onSaved={() => setEditing(false)}
            />
          ) : (
            <>
              <button
                type="button"
                className="ph-lb-nav prev"
                aria-label="Previous photo"
                disabled={idx < 0 || !list[idx - 1]}
                onClick={(e) => {
                  e.stopPropagation();
                  onStep(-1);
                }}
              >
                <ChevronLeftIcon size={24} />
              </button>
              <Stage
                key={asset.asset_id}
                asset={asset}
                onDims={(w, h) => setProbed({ width: w, height: h })}
              />
              <button
                type="button"
                className="ph-lb-nav next"
                aria-label="Next photo"
                disabled={idx < 0 || !list[idx + 1]}
                onClick={(e) => {
                  e.stopPropagation();
                  onStep(1);
                }}
              >
                <ChevronRightIcon size={24} />
              </button>
            </>
          )}
        </div>
        {!editing && infoOpen ? (
          <aside className="ph-lb-info" onClick={(e) => e.stopPropagation()}>
            <LightboxInfo
              key={renderSeq}
              asset={displayAsset}
              albums={albumList}
              places={places}
              refresh={refresh}
              onClose={onClose}
            />
          </aside>
        ) : null}
      </div>

      {!editing ? (
        <div className="ph-lb-filmstrip">
          {list.map((a) => (
            <button
              key={a.asset_id}
              type="button"
              className="ph-lb-frame"
              data-active={a.asset_id === asset.asset_id ? 'true' : 'false'}
              onClick={(e) => {
                e.stopPropagation();
                const i = list.findIndex((x) => x.asset_id === a.asset_id);
                onStep(i - idx);
              }}
            >
              <img src={a.thumb_uri ?? a.content_uri} loading="lazy" alt="" />
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
