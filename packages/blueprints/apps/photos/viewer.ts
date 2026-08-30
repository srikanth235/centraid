// Everything the viewer/slideshow/editor stage knows WITHOUT a DOM. Copy here
// is FINAL, and no user-visible string names a storage noun for a scope.
import { clock, isAudioAsset, isVideoAsset } from "./format.ts";
import {
  PHOTOS_VIDEO_STATUS,
  photosOriginalNotFetched,
} from "./shared-copy.ts";
import { isLiveAsset } from "./tile-state.ts";
import type { Asset } from "./types.ts";

// Pixels OF BAR, never a viewport breakpoint: the info rail narrows it.
export const LABEL_BREAKPOINT = 840;

export function labelsVisible(barWidth: number): boolean {
  return barWidth >= LABEL_BREAKPOINT;
}

export const FIT = 1;

// Discrete rungs, not a pinch factor: every step is pointer-reachable.
export const ZOOM_STEPS: readonly number[] = [FIT, 1.5, 2, 2.4, 3, 4];

export function isZoomed(scale: number): boolean {
  return scale > FIT;
}

export function zoomIn(scale: number): number {
  return ZOOM_STEPS.find((step) => step > scale) ?? ZOOM_STEPS.at(-1) ?? FIT;
}

export function zoomOut(scale: number): number {
  let below = FIT;
  for (const step of ZOOM_STEPS) if (step < scale) below = step;
  return below;
}

// Rounds HERE so the string and the transform cannot disagree.
export function zoomReadout(scale: number): string {
  return `${Math.round(scale * 100)}% · drag to pan`;
}

export const FIT_CHIP = "fit";

export const FIT_ACTION = "Fit";

// From the RECORD, and square when absent: nothing reflows.
export function assetRatio(asset: Asset): number {
  const w = Number(asset.width);
  const h = Number(asset.height);
  return w > 0 && h > 0 ? w / h : 1;
}

export function preferredWidth(targetHeight: number, ratio: number): number {
  return Math.round(targetHeight * ratio);
}

export type TransportKind = "video" | "audio" | "live";

export function transportKind(asset: Asset): TransportKind | null {
  if (isLiveAsset(asset)) return "live";
  if (isVideoAsset(asset)) return "video";
  if (isAudioAsset(asset)) return "audio";
  return null;
}

export const TRANSPORT_LABELS: Readonly<Record<TransportKind, string>> = {
  video: "video",
  audio: "audio",
  live: "live photo",
};

export function videoResolutionLabel(asset: Asset): string | null {
  const height = Number(asset.height);
  if (Number.isNaN(height) || height <= 0) return null;
  if (height >= 2160) return "4K";
  if (height >= 1440) return "1440p";
  if (height >= 1080) return "1080p";
  if (height >= 720) return "720p";
  return `${Math.round(height)}p`;
}

// A field the record lacks is OMITTED, never invented as `?p` or `0:00`.
export function videoKindLabel(asset: Asset): string {
  const parts = ["video"];
  const resolution = videoResolutionLabel(asset);
  if (resolution) parts.push(resolution);
  const duration = Number(asset.duration_s);
  if (duration > 0) parts.push(clock(duration));
  return parts.join(" · ");
}

export { clock } from "./format.ts";

export function trackFraction(elapsed: number, duration: number): number {
  if (Number.isNaN(duration) || duration <= 0) return 0;
  return Math.max(0, Math.min(1, elapsed / duration));
}

export function captureLine(asset: Asset): string {
  const raw = asset.captured_at ?? asset.taken_at;
  if (!raw) return "";
  const when = new Date(raw);
  if (Number.isNaN(when.getTime())) return "";
  const date = when.toLocaleDateString(undefined, {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
  const time = when.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
  return `${date} · ${time}`;
}

function takenDate(asset: Asset): string | null {
  const raw = asset.captured_at ?? asset.taken_at;
  if (!raw) return null;
  const when = new Date(raw);
  if (Number.isNaN(when.getTime())) return null;
  return when.toLocaleDateString(undefined, {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

// Lineage is read, never assumed (#711): an edited copy's `captured_at` is its
// SAVE date, not a capture date.
export function editorSourceLine(asset: Asset, source?: Asset | null): string {
  if (asset.source_asset_id) {
    const resolved =
      source && source.asset_id === asset.source_asset_id ? source : null;
    const date = resolved ? takenDate(resolved) : null;
    return date
      ? `from an edit of a photograph taken ${date}`
      : "from an edit of another photograph in this library";
  }
  const date = takenDate(asset);
  return date
    ? `from a photograph taken ${date}`
    : "from a photograph in this library";
}

export interface OriginStatus {
  text: string;
  action?: string;
}

// Never fetches: loading a full-quality original is ALWAYS an explicit choice.
export function originStatus(
  asset: Asset,
  gatewayName: string
): OriginStatus | null {
  // Video beats the custody line (§7.1): the transport streams the display copy.
  if (isVideoAsset(asset)) {
    return { text: PHOTOS_VIDEO_STATUS };
  }
  const custody = String(asset.custody_state ?? "");
  if (custody === "remote-only") {
    return {
      text: photosOriginalNotFetched(gatewayName),
      action: "Load the original",
    };
  }
  if (custody === "missing") {
    return { text: `The original is not on ${gatewayName} or on this device` };
  }
  if (asset.preview_uri && !asset.content_uri) {
    return {
      text: photosOriginalNotFetched(gatewayName),
      action: "Load the original",
    };
  }
  return null;
}

export const DEFAULT_GATEWAY_NAME = "the gateway";

// `blob.custody_state` is the only per-photograph custody fact an app may read:
// `blob_replica` is not a registered entity, so a destination would be invented.
const ORIGIN_PARAGRAPHS: Record<string, (gatewayName: string) => string> = {
  replicated: (gateway) => `The original is on this device and on ${gateway}.`,
  "remote-only": (gateway) =>
    `The original is on ${gateway}, not on this device — opening it at full quality fetches it.`,
  missing: () =>
    `No copy of the original can be found — its caption, date and albums are still here.`,
  "pending-offsite": (gateway) =>
    `The original is on this device only; a copy to ${gateway} is queued.`,
  "local-only": () =>
    `The original is on this device and nowhere else — losing this device loses the photograph.`,
};

export function originParagraph(asset: Asset, gatewayName: string): string {
  const line = ORIGIN_PARAGRAPHS[String(asset.custody_state ?? "")];
  // No row, no claim: the blob sweep may not have run.
  if (!line)
    return `Where the original is kept has not been checked yet — ${gatewayName} works that out on its own schedule.`;
  return line(gatewayName);
}

export const VIEWER_ACTIONS = [
  "favorite",
  "edit",
  "info",
  "copy",
  "download",
  "slideshow",
] as const;
export type ViewerActionId = (typeof VIEWER_ACTIONS)[number];

export const PHONE_ACTIONS = [
  "copy",
  "favorite",
  "info",
  "edit",
  "trash",
] as const;
export type PhoneActionId = (typeof PHONE_ACTIONS)[number];

// `copy` names a DESTINATION, never `Share`; `copyActionLabel` overrides it.
export const ACTION_LABELS: Readonly<
  Record<ViewerActionId | PhoneActionId, string>
> = {
  favorite: "Favorite",
  edit: "Edit",
  info: "Info",
  copy: "Copy to another place",
  download: "Download",
  slideshow: "Slideshow",
  trash: "Trash",
};

export const SLIDESHOW_STATUS =
  "Esc leaves · the viewer keeps the photograph you stopped on";

export {
  PHOTOS_SAVE_AS_NEW as SAVE_AS_NEW,
  PHOTOS_SAVE_AS_NEW_EXPLANATION as SAVE_AS_NEW_EXPLANATION,
} from "./shared-copy.ts";

// An edit this app cannot express non-destructively is not offered.
export const EDITOR_RATIOS = ["Original", "Square", "3:2"] as const;
export type EditorRatio = (typeof EDITOR_RATIOS)[number];

export function ratioValue(ratio: EditorRatio): number | null {
  if (ratio === "Square") return 1;
  if (ratio === "3:2") return 3 / 2;
  return null;
}

/** In FRACTIONS of the frame. */
export function centredCrop(
  frameRatio: number,
  ratio: number
): { x: number; y: number; w: number; h: number } {
  if (ratio >= frameRatio) {
    const h = frameRatio / ratio;
    return { x: 0, y: (1 - h) / 2, w: 1, h };
  }
  const w = ratio / frameRatio;
  return { x: (1 - w) / 2, y: 0, w, h: 1 };
}

// Two consequences, not three: a place is the member's own or it is not.
export const PERSONAL_MEANING =
  "reachable by nothing. Copy it somewhere shared to let someone see it.";
export const SHARED_MEANING =
  "anyone holding a grant here can see it. Take it out and it stops being shared.";

export function scopeMeaning(personal: boolean | undefined): string {
  return personal === false ? SHARED_MEANING : PERSONAL_MEANING;
}
