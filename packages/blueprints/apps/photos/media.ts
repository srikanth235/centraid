import { scopeAttr } from "../_shared/scope-kit.ts";
import { safeMediaUrl, VAULT_BLOB_PATH } from "../_shared/untrusted.ts";
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

// Grid never fetches a full original: server thumb (#296) or inline `data:`; else placeholder.
// THUMB_EDGE is the SERVE ceiling (must stay 360): client tiny edge is 256 (#405), but older
// uploads must not probe `?variant=thumb`, 404, and flip to a placeholder. v0 never migrates old thumbs.
export const THUMB_EDGE = 360;

export function gridSrc(asset: Asset): string | null | undefined {
  if (isVideoAsset(asset)) return safeMediaUrl(asset.poster_uri);
  if (isAudioAsset(asset)) return null;
  if (typeof asset.thumb_uri === "string") {
    // Known-small blobs never get a thumb staged — `?variant=thumb` 404s. Missing dimensions use the thumb.
    const knownSmall =
      asset.width != null &&
      asset.height != null &&
      Math.max(asset.width, asset.height) <= THUMB_EDGE;
    return safeMediaUrl(knownSmall ? asset.content_uri : asset.thumb_uri);
  }
  // No thumb yet (#708): paint inline `data:` or a vault blob path (Home mosaic does the same).
  // Bare remote URL stays a placeholder — returning null means no `<img>` is built, so the retry cannot cover it.
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
  // `duration_s` of 0 is a still — "0:00" reads as a broken video.
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
  // `--skel`, never `--bg-elev`/`--bg-sunken` (those read as a card; v4 §2.2). Inline so non-React callers match Tile.
  shimmer.style.background = "var(--skel, var(--bg-sunken))";
  tile.appendChild(shimmer);
  if (isVideoAsset(asset)) {
    const badge = document.createElement("span");
    badge.className = "ph-tile-video-badge";
    badge.setAttribute("aria-hidden", "true");
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
  // Stray `duration_s` on a still is not a clip (#708).
  if (!isVideoAsset(asset) && !isAudioAsset(asset)) return;
  const label = durationLabel(asset.duration_s);
  if (!label) return;
  const badge = document.createElement("span");
  badge.className = "ph-tile-duration";
  badge.textContent = label;
  tile.appendChild(badge);
}

/** Callback after the retry ladder; typed loosely so tile-state.ts owns the vocabulary (v4 §14). */
export type MediaReport = (state: "bytes" | "gateway" | "failed") => void;

export function fillTileMedia(
  tile: HTMLElement,
  asset: Asset,
  report?: MediaReport
): void {
  // Stamp scope on the tile before any child (#599): content ids collide across scopes — unstamped = wrong photo, not 404.
  const scope = scopeAttr(asset.scope_id);
  if (scope) tile.dataset.scope = scope;
  const src = gridSrc(asset);
  if (src == null) {
    // Offline/offloaded (§14), not a failure — keep geometry.
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
  if (asset.width != null && asset.height != null) {
    img.width = asset.width;
    img.height = asset.height;
  }
  // One retry against the original (#708): missing derivative, or `blob:` revoked mid-decode (relative path re-enters the authorizer).
  const original = safeMediaUrl(asset.content_uri);
  img.addEventListener("error", () => {
    // Authorizer mid-flight: off-origin this path is the SPA `index.html`. Wait; do not tear the tile down.
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

// Once-per-mount guard for `fillTileMedia`. Pair with `key={asset.asset_id}` to keep the `<img>` across refreshes.
export function mountMedia(
  el: HTMLElement | null,
  asset: Asset,
  report?: MediaReport
): void {
  // Scope + asset id (#599): id-only treats a Family photo as already painted and leaves the previous scope's bytes.
  const key = `${asset.scope_id ?? ""}:${asset.asset_id}`;
  if (!el || el.dataset.mediaFor === key) return;
  el.dataset.mediaFor = key;
  fillTileMedia(el, asset, report);
}
