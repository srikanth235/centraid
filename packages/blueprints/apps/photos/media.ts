import { scopeAttr } from "../_shared/scope-kit.ts";
import { safeMediaUrl, VAULT_BLOB_PATH } from "../_shared/untrusted.ts";
import { clock, isAudioAsset, isVideoAsset } from "./format.ts";
import {
  BLOB_PENDING_ATTR,
  observeNextScreen,
  stopNextScreenObservation,
} from "./media-observer.ts";
import type { Asset } from "./types.ts";

export function isRenderableUri(uri: unknown): boolean {
  return safeMediaUrl(uri) !== null;
}

export const THUMB_EDGE = 360;

export function gridSrc(asset: Asset): string | null | undefined {
  if (isVideoAsset(asset)) return safeMediaUrl(asset.poster_uri);
  if (isAudioAsset(asset)) return null;
  if (typeof asset.thumb_uri === "string") {
    const knownSmall =
      asset.width != null &&
      asset.height != null &&
      Math.max(asset.width, asset.height) <= THUMB_EDGE;
    return safeMediaUrl(knownSmall ? asset.content_uri : asset.thumb_uri);
  }
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
  if (!Number.isFinite(value) || value <= 0) return null;
  return clock(value);
}

function renderPlaceholder(tile: HTMLElement, asset: Asset): void {
  tile.classList.add("is-placeholder");
  const shimmer = document.createElement("span");
  shimmer.className = "ph-tile-ph";
  shimmer.setAttribute("aria-hidden", "true");
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
  if (!isVideoAsset(asset) && !isAudioAsset(asset)) return;
  const label = durationLabel(asset.duration_s);
  if (!label) return;
  const badge = document.createElement("span");
  badge.className = "ph-tile-duration";
  badge.textContent = label;
  tile.appendChild(badge);
}

export type MediaReport = (state: "bytes" | "gateway" | "failed") => void;

export function fillTileMedia(
  tile: HTMLElement,
  asset: Asset,
  report?: MediaReport
): void {
  const scope = scopeAttr(asset.scope_id);
  if (scope) tile.dataset.scope = scope;
  const src = gridSrc(asset);
  if (src == null) {
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
  const original = safeMediaUrl(asset.content_uri);
  img.addEventListener("error", () => {
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

export function mountMedia(
  el: HTMLElement | null,
  asset: Asset,
  report?: MediaReport
): void {
  const key = `${asset.scope_id ?? ""}:${asset.asset_id}`;
  if (!el || el.dataset.mediaFor === key) return;
  el.dataset.mediaFor = key;
  fillTileMedia(el, asset, report);
}
