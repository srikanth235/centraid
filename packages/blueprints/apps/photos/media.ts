import { scopeAttr } from "../_shared/scope-kit.ts";
import { safeMediaUrl, VAULT_BLOB_PATH } from "../_shared/untrusted.ts";
// Tile media: the once-per-mount fill plus the mount guard that makes it safe
// from a React callback ref. JSX-free by design — shared by every tile.
import { isAudioAsset, isVideoAsset } from "./format.ts";
import {
  BLOB_PENDING_ATTR,
  observeNextScreen,
  stopNextScreenObservation,
} from "./media-observer.ts";
import type { Asset } from "./types.ts";

export function isRenderableUri(uri: unknown): boolean {
  return safeMediaUrl(uri) !== null;
}

// THE GRID NEVER FETCHES A FULL ORIGINAL. Blob-backed assets carry a server
// thumb variant (#296); a `data:` URI already rode inline with the row.
// Everything else gets a placeholder rather than multi-MB bytes for one tile.
//
// THUMB_EDGE is the SERVE-side "no thumb was staged below this" ceiling, NOT the
// client generation edge, and it must stay at the LARGER historical 360: the
// preview ladder drops the client tiny edge to 256 (#405), but assets uploaded
// under the older edge must never probe `?variant=thumb`, 404 and flip to a
// placeholder. v0 never migrates old thumbs.
export const THUMB_EDGE = 360;

// The cheap grid source, or null for a placeholder. Video paints its
// device-contributed poster; the original loads only on open.
export function gridSrc(asset: Asset): string | null | undefined {
  if (isVideoAsset(asset)) return safeMediaUrl(asset.poster_uri);
  if (isAudioAsset(asset)) return null;
  if (typeof asset.thumb_uri === "string") {
    // Known-small blobs never get a thumb staged, so `?variant=thumb` is a
    // guaranteed 404 — paint the (already thumb-sized) original directly.
    // Assets without recorded dimensions use the thumb and fall back on a 404.
    const knownSmall =
      asset.width != null &&
      asset.height != null &&
      Math.max(asset.width, asset.height) <= THUMB_EDGE;
    return safeMediaUrl(knownSmall ? asset.content_uri : asset.thumb_uri);
  }
  // No thumb recorded, but two sources are still paintable — refusing them made
  // a freshly imported library a wall of grey boxes (#708), since `thumb_uri`
  // lands only once the preview backstop writes the derivative row:
  //
  //  * a `data:` URI travelled inline with the row, so it costs no network;
  //  * a vault blob path is the ORIGINAL, which the shell's Home mosaic paints
  //    in exactly this state.
  //
  // A bare remote URL stays a placeholder: that would be a full-size original
  // fetched off-device. The `<img>` retry below cannot cover this — returning
  // null means no `<img>` is ever built.
  const inline = typeof asset.content_uri === "string" ? asset.content_uri : "";
  if (inline.startsWith("data:") || inline.startsWith(VAULT_BLOB_PATH)) {
    return safeMediaUrl(asset.content_uri);
  }
  return null;
}

export function durationLabel(
  seconds: number | null | undefined
): string | null {
  const value = Number(seconds);
  // Only a POSITIVE duration is a duration: a `duration_s` of 0 is a still with
  // no timeline, and "0:00" on it reads as a broken video.
  if (!Number.isFinite(value) || value <= 0) return null;
  const total = Math.round(value);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`
    : `${minutes}:${String(secs).padStart(2, "0")}`;
}

function renderPlaceholder(tile: HTMLElement, asset: Asset): void {
  tile.classList.add("is-placeholder");
  const shimmer = document.createElement("span");
  shimmer.className = "ph-tile-ph";
  shimmer.setAttribute("aria-hidden", "true");
  // `--skel`, never `--bg-elev`/`--bg-sunken`: those read as a CARD and an
  // absence is not a card (v4 §2.2). Set here rather than in `.ph-tile-ph` so
  // the three non-React callers agree with the Tile's own skeleton without
  // loading a second stylesheet.
  shimmer.style.background = "var(--skel, var(--bg-sunken))";
  tile.appendChild(shimmer);
  if (isVideoAsset(asset)) {
    const badge = document.createElement("span");
    badge.className = "ph-tile-video-badge";
    badge.setAttribute("aria-hidden", "true");
    // The same triangle PlayIcon draws, so existing badge styling applies.
    badge.innerHTML =
      '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M8 5v14l11-7z"/></svg>';
    tile.appendChild(badge);
  } else if (isAudioAsset(asset)) {
    const badge = document.createElement("span");
    badge.className = "ph-tile-audio-badge";
    badge.setAttribute("aria-hidden", "true");
    badge.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 12v2M8 8v10M12 5v14M16 8v10M20 11v4"/></svg>';
    tile.appendChild(badge);
  }
}

function renderDuration(tile: HTMLElement, asset: Asset): void {
  // A still carrying a stray `duration_s` is a data artefact, not a clip
  // (#708).
  if (!isVideoAsset(asset) && !isAudioAsset(asset)) return;
  const label = durationLabel(asset.duration_s);
  if (!label) return;
  const badge = document.createElement("span");
  badge.className = "ph-tile-duration";
  badge.textContent = label;
  tile.appendChild(badge);
}

// Imperative on purpose: `mountMedia` guards it to run once per mounted element.
/**
 * A callback, never a return value: `pending → bytes` and `pending → failed`
 * happen after the retry ladder, long after this returns. Typed loosely so
 * tile-state.ts stays the one owner of the vocabulary (v4 §14).
 */
export type MediaReport = (state: "bytes" | "gateway" | "failed") => void;

export function fillTileMedia(
  tile: HTMLElement,
  asset: Asset,
  report?: MediaReport
): void {
  // WHICH scope owns these bytes (#599). Content ids are minted per scope and
  // collide across scopes BY DESIGN, so an unstamped tile in a shared audience
  // renders the WRONG photo, not a 404. Stamped on the tile itself, before any
  // child exists, so it covers the `<img>` and the staged `data-prefetch-src`.
  const scope = scopeAttr(asset.scope_id);
  if (scope) tile.dataset.scope = scope;
  const src = gridSrc(asset);
  if (src == null) {
    // NOT a failure: the offline/offloaded case (§14). The tile keeps its shape
    // and colour — a grey mosaic with no explanation is a bug.
    renderPlaceholder(tile, asset);
    renderDuration(tile, asset);
    report?.("gateway");
    return;
  }
  const img = document.createElement("img");
  img.loading = "lazy";
  img.decoding = "async";
  img.fetchPriority = "low";
  img.alt = asset.title ?? asset.kind ?? "Photo";
  // Reserve the aspect box before decode (no CLS). The container is already
  // fixed-size, so these only hint the decoder.
  if (asset.width != null && asset.height != null) {
    img.width = asset.width;
    img.height = asset.height;
  }
  // ONE retry against the original before the tile gives up (#708). Two real
  // failures land here, and either would paint a permanent grey box:
  //
  //  1. The derivative does not exist YET — `?variant=thumb` 404s for every
  //     photo between import and the preview backstop running.
  //  2. The authorized `blob:` URL was revoked mid-decode. Re-assigning the
  //     RELATIVE path re-enters the authorizer's MutationObserver.
  //
  // One retry on a source already committed to, never a policy of preferring
  // originals: a tile that cannot paint is worth more bytes than one that
  // paints nothing.
  const original = safeMediaUrl(asset.content_uri);
  img.addEventListener("error", () => {
    // NOT a verdict on the asset: the authorizer is mid-flight on this raw
    // path, which off the gateway origin answers with the SPA's `index.html`,
    // so the `error` is the un-authorized load. Tearing the tile down here is
    // what made the whole web grid grey — wait for the authorizer instead.
    if (
      img.getAttribute(BLOB_PENDING_ATTR) === "1" &&
      (img.getAttribute("src") ?? "").startsWith(VAULT_BLOB_PATH)
    ) {
      return;
    }
    if (
      original &&
      img.dataset.originalFallback !== "1" &&
      img.src !== original
    ) {
      img.dataset.originalFallback = "1";
      stopNextScreenObservation(img);
      img.src = original;
      return;
    }
    stopNextScreenObservation(img);
    img.remove();
    tile.querySelector(".ph-tile-video-badge")?.remove();
    tile.querySelector(".ph-tile-duration")?.remove();
    renderPlaceholder(tile, asset);
    renderDuration(tile, asset);
    // Ladder exhausted: the terminal failure §14 names. Geometry is kept.
    report?.("failed");
  });
  img.addEventListener("load", () => report?.("bytes"));
  tile.appendChild(img);
  if (isVideoAsset(asset)) {
    const badge = document.createElement("span");
    badge.className = "ph-tile-video-badge";
    badge.setAttribute("aria-hidden", "true");
    badge.innerHTML =
      '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M8 5v14l11-7z"/></svg>';
    tile.appendChild(badge);
  }
  renderDuration(tile, asset);
  observeNextScreen(img, src);
}

// `fillTileMedia` is imperative and must run exactly once per mounted element;
// this is that guard, wired through a React callback ref. Pair it with a stable
// `key={asset.asset_id}` to keep the `<img>` node — and its loaded bytes — alive
// across refreshes.
export function mountMedia(
  el: HTMLElement | null,
  asset: Asset,
  report?: MediaReport
): void {
  // Keyed by SCOPE + asset id (#599): ids collide across scopes, so an id-only
  // guard treats a Family photo as already painted and leaves the previous
  // scope's bytes in place — the wrong-image failure, not a missing one.
  const key = `${asset.scope_id ?? ""}:${asset.asset_id}`;
  if (!el || el.dataset.mediaFor === key) return;
  el.dataset.mediaFor = key;
  fillTileMedia(el, asset, report);
}
