// governance: allow-repo-hygiene file-size-limit The #712 declarative viewer catalog is intentionally kept together so ordering and capability invariants stay auditable.

import { mediaClock } from "@centraid/blueprints/apps/_shared/format-kit";
import {
  PHOTOS_VIDEO_STATUS,
  photosOriginalNotFetched,
} from "@centraid/blueprints/apps/photos/shared-copy";

import { isMeteredConnection } from "../../kit/fetch-gate/gate";

export type ViewerTone = "ink" | "net";

export type ViewerActionId = "copy" | "favorite" | "info" | "edit" | "trash";

export interface ViewerAction {
  id: ViewerActionId;
  label: string;
  icon: string;
  tone: ViewerTone;
}

export const VIEWER_BOTTOM_ACTIONS: readonly ViewerAction[] = [
  { id: "copy", label: "Copy to another place", icon: "share", tone: "ink" },
  { id: "favorite", label: "Favorite", icon: "heart", tone: "ink" },
  { id: "info", label: "Info", icon: "info", tone: "ink" },
  { id: "edit", label: "Edit", icon: "edit-2", tone: "ink" },
  { id: "trash", label: "Trash", icon: "trash-2", tone: "net" },
] as const;

export const VIEWER_ACTION_TARGET = 56;

export interface ViewerActionGroup {
  shape: "chip" | "capsule";
  actions: readonly ViewerActionId[];
}

export const VIEWER_BOTTOM_GROUPS: readonly ViewerActionGroup[] = [
  { actions: ["copy"], shape: "chip" },
  { actions: ["favorite", "info", "edit"], shape: "capsule" },
  { actions: ["trash"], shape: "chip" },
] as const;

export function viewerAction(id: ViewerActionId): ViewerAction {
  const action = VIEWER_BOTTOM_ACTIONS.find((candidate) => candidate.id === id);
  if (!action) throw new Error(`No viewer action named ${id}`);
  return action;
}

export const VIEWER_CHROME_CHIP = 44;

export const VIEWER_CHROME_INSET = 8;

export const VIEWER_TOP_CHROME = ["back", "stamp", "overflow"] as const;

export function viewerChromeHeight(insetTop: number): number {
  return insetTop + VIEWER_CHROME_CHIP + VIEWER_CHROME_INSET * 2;
}

export { READ_ONLY_SOURCE_REASON as READ_ONLY_VAULT_REASON } from "../../kit/replica/row-provenance";

export const FILMSTRIP = {
  height: 58,
  current: 58,
  neighbour: 40,
  currentOutlineWidth: 2,
  gap: 2,
} as const;

export const INFO_SHEET = { heightFraction: 0.64, grabber: true } as const;

export function infoSheetHeight(screenHeight: number): number {
  return Math.round(screenHeight * INFO_SHEET.heightFraction);
}

export const SLIDESHOW = {
  filmstrip: false,
  info: false,
  transports: 0,
  pause: false,
} as const;

export const SLIDESHOW_ACTION = { effect: "leave", label: "Leave" } as const;

export const SLIDESHOW_TITLE = "Slideshow";

export const SLIDESHOW_INTERVAL_MS = 4000;

export function slideshowMeta(index: number, total: number): string {
  const at = slideshowPosition(index, total);
  const seconds = Math.round(SLIDESHOW_INTERVAL_MS / 1000);
  return `${at.position} of ${at.total} · ${seconds} seconds a photograph`;
}

export function slideshowPosition(
  index: number,
  total: number
): { position: string; total: string } {
  return { position: String(index + 1), total: String(total) };
}

const FILENAME_SHAPED = /\.[a-z0-9]{2,5}$/iu;

export function viewerTitle(input: {
  caption?: string;
  filename?: string;
}): string {
  const caption = input.caption?.trim();
  if (caption && !FILENAME_SHAPED.test(caption)) return caption;
  return input.filename?.trim() || caption || "Photograph";
}

export interface CaptureStamp {
  date: string;
  time: string;
}

export function captureStamp(input: {
  capturedAt?: string;
  placeName?: string;
}): CaptureStamp {
  const parsed = input.capturedAt ? new Date(input.capturedAt) : undefined;
  const when = parsed && !Number.isNaN(parsed.getTime()) ? parsed : undefined;
  const place = input.placeName?.trim();
  const clock = when
    ? when.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
    : "";
  return {
    date: when
      ? when.toLocaleDateString(undefined, {
          day: "numeric",
          month: "long",
          year: "numeric",
        })
      : "",
    time: [clock, place].filter(Boolean).join(" · "),
  };
}

export interface VaultLine {
  value: string;
  meaning: string;
}

const PERSONAL_MEANING =
  "Reachable by nothing — copy it somewhere shared to let someone see it.";

export function vaultLine(personal: boolean, label: string): VaultLine {
  return {
    meaning: personal
      ? PERSONAL_MEANING
      : `Anyone with access to ${label} can see this photograph — take it out and it stops being shared.`,
    value: label,
  };
}

export function marksAsElsewhere(personal: boolean): boolean {
  return !personal;
}

export const ZOOM_RUNG = 2.5;

export const ZOOM_MAX = 5;

const ZOOM_STEP = 0.5;

export const ZOOM_FIT = 1;

const ZOOM_EPSILON = 0.001;

export function isZoomed(scale: number): boolean {
  return scale > ZOOM_FIT + ZOOM_EPSILON;
}

export function zoomIn(scale: number): number {
  if (!isZoomed(scale)) return ZOOM_RUNG;
  return Math.min(ZOOM_MAX, scale + ZOOM_STEP);
}

export function zoomOut(scale: number): number {
  return Math.max(ZOOM_FIT, scale - ZOOM_STEP);
}

export interface ZoomReadout {
  mode: "fit" | "zoomed";
  label: string;
}

export function zoomReadout(scale: number): ZoomReadout {
  if (!isZoomed(scale)) return { label: "fit", mode: "fit" };
  return { label: `${zoomPercent(scale)} · drag to pan`, mode: "zoomed" };
}

function zoomPercent(scale: number): string {
  return `${Math.round(scale * 100)}%`;
}

export function fitMedia(
  aspectRatio: number,
  box: { width: number; height: number }
): { width: number; height: number } {
  if (Number.isNaN(aspectRatio) || aspectRatio <= 0)
    return { height: box.height, width: box.width };
  const heightIfWidthBinds = box.width / aspectRatio;
  return heightIfWidthBinds <= box.height
    ? { height: Math.round(heightIfWidthBinds), width: Math.round(box.width) }
    : {
        height: Math.round(box.height),
        width: Math.round(box.height * aspectRatio),
      };
}

export function assetAspectRatio(asset: {
  width?: number;
  height?: number;
}): number {
  const { width, height } = asset;
  if (!width || !height || width <= 0 || height <= 0) return 1.5;
  return width / height;
}

export type TransportVariant = "video" | "audio" | "live";

export interface TransportSpec {
  variant: TransportVariant;
  kindLabel: string;
  play: true;
  determinate: true;
}

const TRANSPORTS: Record<TransportVariant, TransportSpec> = {
  audio: {
    determinate: true,
    kindLabel: "audio",
    play: true,
    variant: "audio",
  },
  live: {
    determinate: true,
    kindLabel: "live photo",
    play: true,
    variant: "live",
  },
  video: {
    determinate: true,
    kindLabel: "video",
    play: true,
    variant: "video",
  },
};

export function transportSpec(
  kind: string,
  hasLiveCompanion = false
): TransportSpec | null {
  if (kind === "video") return TRANSPORTS.video;
  if (kind === "audio") return TRANSPORTS.audio;
  if (hasLiveCompanion) return TRANSPORTS.live;
  return null;
}

export { mediaClock as formatMediaClock } from "@centraid/blueprints/apps/_shared/format-kit";

function videoResolutionLabel(asset: { height?: number }): string | null {
  const height = Number(asset.height);
  if (Number.isNaN(height) || height <= 0) return null;
  if (height >= 2160) return "4K";
  if (height >= 1440) return "1440p";
  if (height >= 1080) return "1080p";
  if (height >= 720) return "720p";
  return `${Math.round(height)}p`;
}

export function videoKindLabel(asset: {
  height?: number;
  durationS?: number;
}): string {
  const parts = ["video"];
  const resolution = videoResolutionLabel(asset);
  if (resolution) parts.push(resolution);
  const duration = Number(asset.durationS);
  if (duration > 0) parts.push(mediaClock(duration));
  return parts.join(" · ");
}

export type OriginalPlacement =
  | "on-device"
  | "offloaded"
  | "on-gateway"
  | "metered";

export interface OriginalStatus {
  placement: OriginalPlacement;
  text: string;
  action?: string;
}

export const LOAD_THE_ORIGINAL = "Load the original";

export function resolveOriginalPlacement(input: {
  hasDeviceOriginal: boolean;
  offloaded?: boolean;
  networkType?: string;
  unlocked?: boolean;
}): OriginalPlacement {
  if (input.hasDeviceOriginal && input.offloaded !== true) return "on-device";
  if (input.hasDeviceOriginal) return "offloaded";
  if (input.unlocked !== true && isMeteredConnection(input.networkType))
    return "metered";
  return "on-gateway";
}

export function originalStatus(
  placement: OriginalPlacement,
  gatewayName: string
): OriginalStatus {
  switch (placement) {
    case "on-device":
      return { placement, text: "Original on this device" };
    case "offloaded":
      return {
        action: LOAD_THE_ORIGINAL,
        placement,
        text: "Original offloaded by this device · a full-quality copy has not been fetched",
      };
    case "metered":
      return {
        action: LOAD_THE_ORIGINAL,
        placement,
        text: `Original on ${gatewayName} · loading it spends mobile data`,
      };
    case "on-gateway":
      return {
        action: LOAD_THE_ORIGINAL,
        placement,
        text: photosOriginalNotFetched(gatewayName),
      };
  }
}

export function originalWhereabouts(status: OriginalStatus): string {
  if (status.placement === "on-device")
    return "The original is on this device.";
  if (status.placement === "offloaded")
    return "This device moved the original off to free space — fetching it back is your choice, once.";
  if (status.placement === "metered")
    return "The original is on the gateway and this connection is metered — fetching a full-quality copy is your choice.";
  return "The original is on the gateway — opening reads a smaller copy, and fetching the full-quality one is your choice.";
}

const VIEWER_GESTURE_STATUS =
  "Swipe for the next · pinch or double tap to zoom · swipe up for info";

const VIDEO_STATUS = PHOTOS_VIDEO_STATUS;

function zoomedStatus(scale: number): string {
  return `${zoomPercent(scale)} · drag to pan · double tap returns to fit`;
}

export interface ViewerStatus {
  text: string;
  action?: string;
}

export function viewerStatus(input: {
  scale: number;
  kind: string;
  bytes: OriginalStatus;
}): ViewerStatus {
  if (isZoomed(input.scale)) return { text: zoomedStatus(input.scale) };
  if (input.bytes.action)
    return { action: input.bytes.action, text: input.bytes.text };
  if (input.kind === "video") return { text: VIDEO_STATUS };
  return { text: VIEWER_GESTURE_STATUS };
}

export const GESTURE_POINTER_EQUIVALENTS: Readonly<Record<string, string>> = {
  "double tap": "Zoom to fit",
  drag: "Fit to the screen",
  pinch: "Zoom to fit",
  "swipe left": "Next photograph",
  "swipe right": "Previous photograph",
  "swipe up": "Info",
} as const;
