// What the phone viewer *is*, as data — separate from what draws it.
// governance: allow-repo-hygiene file-size-limit The #712 declarative viewer catalog is intentionally kept together so ordering and capability invariants stay auditable.
//
// The phone REARRANGES the desktop viewer; it does not water it down. Same five
// actions, same names, same order, same marks. Every such decision is a value
// here rather than a number in a StyleSheet, so it can be asserted without
// rendering React Native (§7, CHANGELOG §D) — keep it that way.
//
// Nothing here reads a colour: tones are named (`ink` / `net`) and resolved at
// the call site. A hex here would be a second source of truth.

// The leaf module, never `kit/fetch-gate`'s barrel: the barrel re-exports
// `FetchChoice.tsx`, which pulls in `react-native`.
import {
  PHOTOS_VIDEO_STATUS,
  photosOriginalNotFetched,
} from "@centraid/blueprints/apps/photos/shared-copy";

import { isMeteredConnection } from "../../kit/fetch-gate/gate";

/** The tone a control takes. Resolved to `colors.onStage` / `colors.net`. */
export type ViewerTone = "ink" | "net";

export type ViewerActionId = "copy" | "favorite" | "info" | "edit" | "trash";

export interface ViewerAction {
  id: ViewerActionId;
  /** Accessibility label. Icon-only controls are never unlabelled (§18). */
  label: string;
  /** Icon key. An action that changes its mark between surfaces is a
   *  different action to the member (CHANGELOG B2), so this is binding. */
  icon: string;
  tone: ViewerTone;
}

/**
 * The five, in the order the desktop bar carries them. Trash is the only `net`
 * one, drawn as an outline — a destructive control is never a large filled
 * surface (§18).
 */
export const VIEWER_BOTTOM_ACTIONS: readonly ViewerAction[] = [
  // Names a DESTINATION, never the verb `Share` with an invisible effect
  // (#726), and matches the web's `ACTION_LABELS.copy` so the two clients
  // cannot name one action differently. `label` is both the visible and the
  // spoken name; splitting them is a WCAG 2.5.3 failure.
  { id: "copy", label: "Copy to another place", icon: "share", tone: "ink" },
  { id: "favorite", label: "Favorite", icon: "heart", tone: "ink" },
  { id: "info", label: "Info", icon: "info", tone: "ink" },
  { id: "edit", label: "Edit", icon: "edit-2", tone: "ink" },
  { id: "trash", label: "Trash", icon: "trash-2", tone: "net" },
] as const;

/** Thumb targets. Above the 44 floor because this is the primary bar (§7.1). */
export const VIEWER_ACTION_TARGET = 56;

/**
 * THE BOTTOM ROW'S ANATOMY: chip · capsule · chip — grouped by CONSEQUENCE. The
 * end chips each carry one action that reaches beyond this photograph (Copy,
 * Trash); the middle capsule carries the three that do not.
 *
 * Flattening these groups must reproduce `VIEWER_BOTTOM_ACTIONS` exactly — that
 * equality is what keeps this a rearrangement of the desktop bar rather than a
 * different set of controls (CHANGELOG §D), and it is asserted.
 */
export interface ViewerActionGroup {
  /** `chip` is one round plate around one action; `capsule` is a pill that
   *  carries several, divided by nothing but their own targets. */
  shape: "chip" | "capsule";
  actions: readonly ViewerActionId[];
}

export const VIEWER_BOTTOM_GROUPS: readonly ViewerActionGroup[] = [
  { actions: ["copy"], shape: "chip" },
  { actions: ["favorite", "info", "edit"], shape: "capsule" },
  { actions: ["trash"], shape: "chip" },
] as const;

/** The action a group names. Throws rather than rendering an empty target: a
 *  group naming an id the list does not carry is a wiring bug, not a state. */
export function viewerAction(id: ViewerActionId): ViewerAction {
  const action = VIEWER_BOTTOM_ACTIONS.find((candidate) => candidate.id === id);
  if (!action) throw new Error(`No viewer action named ${id}`);
  return action;
}

/** The touch floor EXACTLY, and deliberately not the bar's 56: a 56 circle
 *  floating on a photograph is a plate, not a chip. The capsule keeps 56 per
 *  target because those targets are neighbours. */
export const VIEWER_CHROME_CHIP = 44;

/** How far the floating chrome stands off the stage's edges. Stated once so
 *  the layout and `viewerChromeHeight` cannot drift apart. */
export const VIEWER_CHROME_INSET = 8;

/** Leading→trailing. There is NO top bar: a full-width strip is a second ground
 *  over the photograph. The stamp takes the middle because it is the only one
 *  that is not a control. */
export const VIEWER_TOP_CHROME = ["back", "stamp", "overflow"] as const;

/** The viewer never subtracts this — the stage runs UNDER the floating chrome.
 *  The editor does subtract it: its own top controls must not be obscured. */
export function viewerChromeHeight(insetTop: number): number {
  return insetTop + VIEWER_CHROME_CHIP + VIEWER_CHROME_INSET * 2;
}

/** The ONE sentence for this truth on the phone (§6, §18). Since #880 it
 *  lives in `kit/replica/row-provenance.ts`, read by five apps. */
export { READ_ONLY_SOURCE_REASON as READ_ONLY_VAULT_REASON } from "../../kit/replica/row-provenance";

/** Kept on the phone: swipe and the strip are one control from two directions,
 *  and dropping it makes the phone a slideshow. */
export const FILMSTRIP = {
  height: 58,
  current: 58,
  neighbour: 40,
  currentOutlineWidth: 2,
  gap: 2,
} as const;

/** The info rail, as a sheet: 64% of the screen, with a grabber (§7.2). */
export const INFO_SHEET = { heightFraction: 0.64, grabber: true } as const;

export function infoSheetHeight(screenHeight: number): number {
  return Math.round(screenHeight * INFO_SHEET.heightFraction);
}

/**
 * A different MODE from the viewer, not the viewer with things switched off:
 * no filmstrip, no info, determinate position (§7.3).
 *
 * A MODEL MUST NOT DESCRIBE CONTROLS THAT DO NOT RENDER — `transports: 1` while
 * the phone renders none makes model, mark and behaviour three stories (#711).
 * A phone transport is a recorded NON-GOAL; when one is built, `transports`
 * goes to 1 and this note goes away.
 */
export const SLIDESHOW = {
  filmstrip: false,
  info: false,
  transports: 0,
  pause: false,
} as const;

/** One object, so label and effect are read from the SAME value and cannot
 *  drift into a pause glyph that exits. */
export const SLIDESHOW_ACTION = { effect: "leave", label: "Leave" } as const;

export const SLIDESHOW_TITLE = "Slideshow";

/** A PROMISE, not a taste: `slideshowMeta` prints this number on screen. */
export const SLIDESHOW_INTERVAL_MS = 4000;

/** `12 of 184 · 4 seconds a photograph` — the only place the position index
 *  appears; the viewer's own meta line carries the capture line (proto 4511). */
export function slideshowMeta(index: number, total: number): string {
  const at = slideshowPosition(index, total);
  const seconds = Math.round(SLIDESHOW_INTERVAL_MS / 1000);
  return `${at.position} of ${at.total} · ${seconds} seconds a photograph`;
}

/** `12` / `184` — determinate, and both halves read in the numeric register. */
export function slideshowPosition(
  index: number,
  total: number
): { position: string; total: string } {
  return { position: String(index + 1), total: String(total) };
}

// ───────────────────────────────────────────────────────────────────────────
// What the floating stamp says
// ───────────────────────────────────────────────────────────────────────────

/** `timeline-engine.ts` flattens a vault row's `title` into `filename`, so a
 *  caption and a file name arrive in one field. A value still SHAPED like a
 *  file name was never captioned, and must stay a last-resort fallback rather
 *  than be promoted to a caption the member never wrote. */
const FILENAME_SHAPED = /\.[a-z0-9]{2,5}$/iu;

export function viewerTitle(input: {
  caption?: string;
  filename?: string;
}): string {
  const caption = input.caption?.trim();
  if (caption && !FILENAME_SHAPED.test(caption)) return caption;
  return input.filename?.trim() || caption || "Photograph";
}

/**
 * `30 July 2026` over `17:42 · Lyme Regis` — the floating stamp. WHEN outranks
 * WHAT: the date takes the first line and the emphasis.
 *
 * Composition matches the web viewer's `captureLine` field for field, so the
 * two clients cannot describe one photograph differently; only the LINE BREAK
 * is the phone's. No capture time ⇒ both fields empty and the caller shows the
 * name — never an invented date.
 */
export interface CaptureStamp {
  date: string;
  /** The place stops the line short when there is none, never leaving a
   *  dangling separator. */
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

// ───────────────────────────────────────────────────────────────────────────
// The vault a photograph is in
// ───────────────────────────────────────────────────────────────────────────

/**
 * Sharing is a PLACE a photograph is in, not a permission on it, and the only
 * fact on the vault record is whether it is the member's own (CHANGELOG §H). A
 * vault someone named "Sharing" is still their own. There is no third kind of
 * place — a copy lands in the recipient's vault.
 */
export interface VaultLine {
  value: string;
  /** A pure function of `personal`, never of the label. */
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

/** The tile / info marker fires for any vault but the member's own (§4.4). */
export function marksAsElsewhere(personal: boolean): boolean {
  return !personal;
}

// ───────────────────────────────────────────────────────────────────────────
// Zoom
// ───────────────────────────────────────────────────────────────────────────

/** THE rung — one number for every way into a zoom. A double tap and a `+` that
 *  land on different magnifications are two controls wearing one name. */
export const ZOOM_RUNG = 2.5;

/** The ceiling the pinch is clamped to. Past this a preview is pixels. */
export const ZOOM_MAX = 5;

/** What one press of `−` / `+` is worth once the ladder is already climbed. */
const ZOOM_STEP = 0.5;

/** `fit` is the floor: the photograph is never smaller than its own frame. */
export const ZOOM_FIT = 1;

/** A pinch settles on 1.0000001 often enough that an exact comparison reads
 *  `100% · drag to pan` on a photograph that is not zoomed at all. */
const ZOOM_EPSILON = 0.001;

export function isZoomed(scale: number): boolean {
  return scale > ZOOM_FIT + ZOOM_EPSILON;
}

/** The first `+` lands on the rung; after that the ladder climbs by a step. */
export function zoomIn(scale: number): number {
  if (!isZoomed(scale)) return ZOOM_RUNG;
  return Math.min(ZOOM_MAX, scale + ZOOM_STEP);
}

/** `−` walks back down and stops at fit — it never inverts into a shrink. */
export function zoomOut(scale: number): number {
  return Math.max(ZOOM_FIT, scale - ZOOM_STEP);
}

export interface ZoomReadout {
  mode: "fit" | "zoomed";
  /** `fit`, or an exact readout: `240% · drag to pan`. */
  label: string;
}

export function zoomReadout(scale: number): ZoomReadout {
  if (!isZoomed(scale)) return { label: "fit", mode: "fit" };
  return { label: `${zoomPercent(scale)} · drag to pan`, mode: "zoomed" };
}

function zoomPercent(scale: number): string {
  return `${Math.round(scale * 100)}%`;
}

/** The box is the constraint and the asset's own ratio decides which axis binds.
 *  The ratio comes from the RECORD, known before the bytes arrive — which is
 *  what stops a tile reflowing when they land (§7.1, §14). */
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

/** The ratio the record carries, or the 3:2 the packer assumes without one. */
export function assetAspectRatio(asset: {
  width?: number;
  height?: number;
}): number {
  const { width, height } = asset;
  if (!width || !height || width <= 0 || height <= 0) return 1.5;
  return width / height;
}

// ───────────────────────────────────────────────────────────────────────────
// Transports — one slot, three variants
// ───────────────────────────────────────────────────────────────────────────

export type TransportVariant = "video" | "audio" | "live";

export interface TransportSpec {
  variant: TransportVariant;
  /** Micro-caps kind label. The style uppercases; the copy does not shout. */
  kindLabel: string;
  play: true;
  /** Never indeterminate. No spinner, ever (§18). */
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

/** ROUNDS, never truncates — the twin of the web viewer's `clock`, and one
 *  recording must not have two lengths across the clients. */
export function formatMediaClock(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(whole / 60);
  return `${minutes}:${String(whole % 60).padStart(2, "0")}`;
}

/** From the RECORD's pixel height — never a filename or codec guess. A height
 *  between rungs reads an honest `NNNp` rather than being promoted. Mirrors the
 *  web's `videoResolutionLabel` rung for rung. */
function videoResolutionLabel(asset: { height?: number }): string | null {
  const height = Number(asset.height);
  if (Number.isNaN(height) || height <= 0) return null;
  if (height >= 2160) return "4K";
  if (height >= 1440) return "1440p";
  if (height >= 1080) return "1080p";
  if (height >= 720) return "720p";
  return `${Math.round(height)}p`;
}

/** `video · 4K · 0:24` (proto 4541). A field the record lacks is OMITTED, never
 *  invented as `?p` or `0:00`. Part for part, the web's `videoKindLabel`. */
export function videoKindLabel(asset: {
  height?: number;
  durationS?: number;
}): string {
  const parts = ["video"];
  const resolution = videoResolutionLabel(asset);
  if (resolution) parts.push(resolution);
  const duration = Number(asset.durationS);
  if (duration > 0) parts.push(formatMediaClock(duration));
  return parts.join(" · ");
}

// ───────────────────────────────────────────────────────────────────────────
// Where the bytes are
// ───────────────────────────────────────────────────────────────────────────

/** Each is a truthful state — never a broken image (§12). */
export type OriginalPlacement =
  | "on-device"
  | "offloaded"
  | "on-gateway"
  | "metered";

export interface OriginalStatus {
  placement: OriginalPlacement;
  /** The status line inside the stage: what is true about the bytes. */
  text: string;
  /** The one inline action, or none when there is nothing to fetch. */
  action?: string;
}

/** One string, so it cannot drift between rows. */
export const LOAD_THE_ORIGINAL = "Load the original";

export function resolveOriginalPlacement(input: {
  hasDeviceOriginal: boolean;
  offloaded?: boolean;
  networkType?: string;
  unlocked?: boolean;
}): OriginalPlacement {
  if (input.hasDeviceOriginal && input.offloaded !== true) return "on-device";
  if (input.hasDeviceOriginal) return "offloaded";
  // Metered is a state of the *fetch*, not the bytes, and outranks "on the
  // gateway" because it is the thing the member must decide.
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

/** Says where the bytes are AND what fetching costs: "explicit choice" is only
 *  honest if the choice is described before it is offered. */
export function originalWhereabouts(status: OriginalStatus): string {
  if (status.placement === "on-device")
    return "The original is on this device.";
  if (status.placement === "offloaded")
    return "This device moved the original off to free space — fetching it back is your choice, once.";
  if (status.placement === "metered")
    return "The original is on the gateway and this connection is metered — fetching a full-quality copy is your choice.";
  return "The original is on the gateway — opening reads a smaller copy, and fetching the full-quality one is your choice.";
}

// ───────────────────────────────────────────────────────────────────────────
// The one status line inside the stage
// ───────────────────────────────────────────────────────────────────────────

/** The phone's teaching line (proto 4637–4639): its gestures are not
 *  discoverable, so the stage's one line teaches them until the bytes have
 *  something better to say. */
const VIEWER_GESTURE_STATUS =
  "Swipe for the next · pinch or double tap to zoom · swipe up for info";

/** Video's status (proto 4642): what is playing, and which copy of it. */
const VIDEO_STATUS = PHOTOS_VIDEO_STATUS;

/** `240% · drag to pan · double tap returns to fit` — live, never a stub. */
function zoomedStatus(scale: number): string {
  return `${zoomPercent(scale)} · drag to pan · double tap returns to fit`;
}

export interface ViewerStatus {
  text: string;
  /** The one inline action, or none. Zoomed and video states carry none. */
  action?: string;
}

/**
 * The stage's ONE line, and the precedence is deliberate — NOT "the bytes
 * always win", which would keep the gesture line and zoom readout off screen.
 *
 * 1. **Zoomed** outranks everything, and drops the inline action (proto 4644):
 *    a fetch that reflows the photograph under a pinched finger fires into a
 *    moving target.
 * 2. **A byte status with something to DO** — the only case offering a choice,
 *    and an offer beats a lesson.
 * 3. **Video**, describing the copy that is playing.
 * 4. Otherwise the teaching line. "Original on this device" lands here: no
 *    action, no cost, and the info sheet carries it under Facts anyway.
 */
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

// ───────────────────────────────────────────────────────────────────────────
// Gestures
// ───────────────────────────────────────────────────────────────────────────

/** Nothing is reachable by gesture alone (§15): every gesture has a control
 *  doing the same job, and the pairing is asserted. */
export const GESTURE_POINTER_EQUIVALENTS: Readonly<Record<string, string>> = {
  "double tap": "Zoom to fit",
  // `Fit` is drag's equivalent: a member who cannot drag reaches what they
  // cannot see by returning the whole photograph to the screen. A phone has no
  // arrow keys to offer instead.
  drag: "Fit to the screen",
  pinch: "Zoom to fit",
  "swipe left": "Next photograph",
  "swipe right": "Previous photograph",
  "swipe up": "Info",
} as const;
