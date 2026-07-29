import { useState } from "react";

import { displayText, safeMediaUrl } from "../../_shared/untrusted.ts";
import { toggleFavorite } from "../assets-actions.ts";
import { assetBytes, isAudioAsset, isVideoAsset } from "../format.ts";
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
} from "../icons.tsx";
// The redesigned lightbox: near-black stage with prev/next arrows and a
// bottom filmstrip, a top bar of icon actions, and the info panel (split out
// to LightboxInfo.tsx — see its header comment). `refresh`/`onClose` are the
// only app.tsx-owned pieces threaded down; every command fires through `act`
// (outcomes.ts) directly, same contract as before. `onSlideshow`/`onEdit`
// swap this region for a different one (slideshow.tsx / this file's own
// EditorView), which only the shell here can do.
// CSS split: React-owned classes in Lightbox.module.css; the imperatively
// toggled `zoomable`/`zoomed`/`is-placeholder` markers stay global strings.
import { fmtBytes, toast } from "../kit.ts";
import { gridSrc, isRenderableUri } from "../media.ts";
import { act, narrate } from "../outcomes.ts";
import { canWriteScope, scopeAttr } from "../scopes.ts";
import type { Album, Asset, Place } from "../types.ts";
import { EditorView } from "./Editor.tsx";
import { LightboxInfo } from "./LightboxInfo.tsx";

import styles from "./Lightbox.module.css";

interface Dims {
  width: number;
  height: number;
}

function withProbedDims(asset: Asset, probed: Dims | null): Asset {
  return probed && asset.width == null && asset.height == null
    ? { ...asset, ...probed }
    : asset;
}

// Double-click zooms the stage image; while zoomed a pointer drag pans it —
// unchanged from the pre-redesign lightbox, just re-hosted here.
function wireZoom(img: HTMLImageElement): void {
  let zoomed = false;
  let panX = 0;
  let panY = 0;
  let dragging = false;
  let startX = 0;
  let startY = 0;
  const apply = () => {
    img.style.transform = zoomed
      ? `translate(${panX}px, ${panY}px) scale(2.5)`
      : "";
    img.classList.toggle("zoomed", zoomed);
  };
  img.classList.add("zoomable");
  img.addEventListener("dblclick", (e) => {
    e.stopPropagation();
    zoomed = !zoomed;
    panX = 0;
    panY = 0;
    apply();
  });
  img.addEventListener("pointerdown", (e) => {
    if (!zoomed) return;
    dragging = true;
    startX = e.clientX - panX;
    startY = e.clientY - panY;
    img.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  img.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    panX = e.clientX - startX;
    panY = e.clientY - startY;
    apply();
  });
  const stop = () => {
    dragging = false;
  };
  img.addEventListener("pointerup", stop);
  img.addEventListener("pointercancel", stop);
  img.addEventListener("click", (e) => e.stopPropagation());
}

// `onDims` fires once, on load, only when the asset row itself carries no
// width/height (an older upload, or a codec this vault's minimal EXIF walk
// didn't probe) — the same "derive it from the live image" fallback the
// pre-redesign lightbox had, just re-hosted here instead of behind a
// PanelBody-owned ref.
export function Stage({
  asset,
  onDims,
}: {
  asset: Asset;
  onDims: (w: number, h: number) => void;
}) {
  // Every branch below points at this asset's bytes, and the lightbox steps
  // through a MERGED list, so each one names the scope those bytes live in
  // (issue #599) — see fillTileMedia's note on why an unstamped reference in a
  // shared audience renders the wrong photo rather than failing.
  const scope = scopeAttr(asset.scope_id);
  const contentSrc = safeMediaUrl(asset.content_uri);
  const posterSrc = safeMediaUrl(asset.poster_uri);
  if (contentSrc && isVideoAsset(asset)) {
    return (
      <video
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
        <span aria-hidden="true">♪</span>
        <audio
          src={contentSrc}
          controls
          preload="metadata"
          aria-label={displayText(asset.title ?? "Audio")}
        >
          {/* The vault has no caption sidecar for media assets yet, so there is
              nothing to point `src` at — this is the wiring point for when it
              does. Muting instead would be dishonest: this is a real player the
              user presses play on. */}
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
      <img
        data-scope={scope}
        src={displaySrc}
        alt={displayText(asset.title ?? asset.kind ?? "Photo")}
        decoding="async"
        ref={(el) => {
          if (!el || el.dataset.zoomWired) return;
          el.dataset.zoomWired = "1";
          wireZoom(el);
        }}
        onLoad={(e) => {
          if (needsProbe)
            onDims(e.currentTarget.naturalWidth, e.currentTarget.naturalHeight);
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
    );
  }
  return (
    <div className={styles.placeholder}>
      {asset.media_type ?? asset.kind ?? "media"}
    </div>
  );
}

function dateLine(asset: Asset): string {
  const t = asset.taken_at ? new Date(asset.taken_at) : null;
  const when =
    t && !Number.isNaN(t.getTime())
      ? t.toLocaleString(undefined, { dateStyle: "full", timeStyle: "short" })
      : null;
  return (
    [when, displayText(asset.place?.name)].filter(Boolean).join(" · ") ||
    fmtBytes(assetBytes(asset))
  );
}

async function handleShare(asset: Asset): Promise<void> {
  const mediaUrl = safeMediaUrl(asset.content_uri);
  const url = mediaUrl?.startsWith("data:") ? location.href : (mediaUrl ?? "");
  if (navigator.share) {
    try {
      await navigator.share({
        title: displayText(asset.title ?? "Photo"),
        url,
      });
      return;
    } catch {
      return; // the user cancelled the native share sheet — not an error
    }
  }
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(url);
      toast("Link copied.");
      return;
    } catch {
      /* fall through */
    }
  }
  toast("Sharing isn’t available in this browser.");
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
}: {
  asset: Asset;
  idx: number;
  list: Asset[];
  albums: Album[];
  places: Place[];
  renderSeq: number;
  onStep: (delta: number) => void;
  refresh: () => Promise<void>;
  onClose: () => void;
  onSlideshow: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [infoOpen, setInfoOpen] = useState(true);
  const [probed, setProbed] = useState<Dims | null>(null);
  // Dims probed off the previous asset are dropped during the render that first
  // sees a new asset_id (React's "adjust state when a prop changes" pattern),
  // not one commit later from an effect — an effect would paint the old
  // dimensions against the new photo for a frame (#573).
  const [probedFor, setProbedFor] = useState(asset.asset_id);
  if (probedFor !== asset.asset_id) {
    setProbedFor(asset.asset_id);
    setProbed(null);
  }
  const displayAsset = withProbedDims(asset, probed);
  // Same rule as the grid tile: a read-only audience's photo is viewable, and
  // the actions that would write are disabled rather than refused (#599).
  const canWrite = canWriteScope(asset.scope_id);
  return (
    <div className={styles.lightbox}>
      <div className={styles.topbar}>
        <button
          type="button"
          className={styles.iconBtn}
          aria-label="Close"
          onClick={onClose}
        >
          <CloseIcon />
        </button>
        <div className={styles.heading}>
          <div className={styles.title}>
            {displayText(asset.title || asset.place?.name || "Photo")}
          </div>
          <div className={styles.dateline}>{dateLine(displayAsset)}</div>
        </div>
        {editing ? null : (
          <>
            <button
              type="button"
              className={styles.iconBtn}
              disabled={!canWrite}
              data-active={asset.favorite ? "true" : "false"}
              aria-pressed={asset.favorite ? "true" : "false"}
              aria-label={
                asset.favorite ? "Remove from favorites" : "Add to favorites"
              }
              onClick={() => toggleFavorite(asset, refresh)}
            >
              <HeartIcon filled={!!asset.favorite} />
            </button>
            <button
              type="button"
              className={styles.iconBtn}
              aria-label="Slideshow"
              onClick={onSlideshow}
            >
              <PlayIcon />
            </button>
            {isRenderableUri(asset.content_uri) &&
            !isVideoAsset(asset) &&
            canWrite ? (
              <button
                type="button"
                className={styles.iconBtn}
                aria-label="Edit"
                onClick={() => setEditing(true)}
              >
                <EditIcon />
              </button>
            ) : null}
            {safeMediaUrl(asset.content_uri) ? (
              <a
                className={styles.iconBtn}
                data-scope={scopeAttr(asset.scope_id)}
                aria-label="Download"
                href={safeMediaUrl(asset.content_uri) ?? undefined}
                download={
                  displayText(asset.title).trim() || `photo-${asset.asset_id}`
                }
              >
                <DownloadIcon />
              </a>
            ) : null}
            <button
              type="button"
              className={styles.iconBtn}
              aria-label="Share"
              onClick={() => handleShare(asset)}
            >
              <ShareIcon />
            </button>
            <button
              type="button"
              className={styles.iconBtn}
              disabled={!canWrite}
              aria-label="Delete"
              onClick={async () => {
                const outcome = await act(
                  "delete-asset",
                  { asset_id: asset.asset_id },
                  asset.scope_id
                );
                if (narrate(outcome)) {
                  onClose();
                  toast("Moved to trash — it leaves every album it was in.", {
                    undoLabel: "Undo",
                    onUndo: async () => {
                      await act(
                        "restore",
                        { asset_id: asset.asset_id },
                        asset.scope_id
                      );
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
              className={styles.iconBtn}
              data-active={infoOpen ? "true" : "false"}
              aria-pressed={infoOpen ? "true" : "false"}
              aria-label="Info"
              onClick={() => setInfoOpen((v) => !v)}
            >
              <InfoIcon />
            </button>
          </>
        )}
      </div>

      <div className={styles.body}>
        {/* No backdrop-shield onClick here: `#lightbox`'s native close listener
            already gates on `e.target === e.currentTarget` (see lightbox.tsx),
            so a click on this region never reached it in the first place. */}
        <div className={styles.stagewrap}>
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
                className={`${styles.nav} prev`}
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
                className={`${styles.nav} next`}
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
          <aside className={styles.info}>
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

      {editing ? null : (
        <div className={styles.filmstrip}>
          {list.map((a) => {
            // Same cheap-source rule as the grid: a thumb (or inline data URI),
            // never a full remote original, and a placeholder for videos.
            const src = gridSrc(a);
            return (
              <button
                // Scope-qualified for the same reason the grid's tiles are.
                key={`${a.scope_id ?? ""}:${a.asset_id}`}
                type="button"
                className={
                  src ? styles.frame : `${styles.frame} is-placeholder`
                }
                data-active={a.asset_id === asset.asset_id ? "true" : "false"}
                /* The strip mixes scopes: each frame names its own so the
                   authorizer's nearest-ancestor lookup finds the right one. */
                data-scope={scopeAttr(a.scope_id)}
                onClick={(e) => {
                  e.stopPropagation();
                  const i = list.findIndex((x) => x.asset_id === a.asset_id);
                  onStep(i - idx);
                }}
              >
                {src ? (
                  <img src={src} loading="lazy" decoding="async" alt="" />
                ) : null}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
