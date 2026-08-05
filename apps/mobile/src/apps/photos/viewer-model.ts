// What the phone viewer *is*, as data — separate from what draws it.
//
// The phone rearranges the desktop viewer; it does not water it down. Same five
// actions, same names, same order, same marks — moved to where a thumb is. The
// filmstrip stays. The info rail becomes a sheet. Every one of those decisions
// is a value in this module rather than a number buried in a StyleSheet, so it
// can be asserted without rendering React Native (§7, CHANGELOG §D).
//
// Nothing here reads a colour: tones are named (`ink` / `net`) and resolved
// against the native token layer at the call site. RN has no `oklch()`, so the
// tokens are already concrete there — but a hex in this file would be a second
// source of truth for a value the design system owns.

// Imports the leaf module rather than `kit/fetch-gate`'s barrel: this file is
// asserted without rendering React Native (see the module comment above), and
// the barrel also re-exports `FetchChoice.tsx`, which pulls in `react-native`.
import { isMeteredConnection } from "../../kit/fetch-gate/gate";

/** The tone a control takes. Resolved to `colors.onStage` / `colors.net`. */
export type ViewerTone = "ink" | "net";

export type ViewerActionId = "sharing" | "favorite" | "info" | "edit" | "trash";

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
 * The five, in the order the desktop bar carries them. Trash is the only one in
 * `--net`, and it is an outline — a destructive control is never a large filled
 * surface (§18).
 */
export const VIEWER_BOTTOM_ACTIONS: readonly ViewerAction[] = [
  // `Sharing`, not `Copy to Sharing` (proto 4490). The phone bar DRAWS this
  // label under the mark at 11px across a fifth of a 390px screen, so the verb
  // is dropped and the destination kept — and because the visible label and the
  // spoken one are read from this same field, they cannot disagree (a control
  // whose accessible name is not its visible label is a WCAG 2.5.3 failure).
  { id: "sharing", label: "Sharing", icon: "share", tone: "ink" },
  { id: "favorite", label: "Favorite", icon: "heart", tone: "ink" },
  { id: "info", label: "Info", icon: "info", tone: "ink" },
  { id: "edit", label: "Edit", icon: "edit-2", tone: "ink" },
  { id: "trash", label: "Trash", icon: "trash-2", tone: "net" },
] as const;

/** Thumb targets. Above the 44 floor because this is the primary bar (§7.1). */
export const VIEWER_ACTION_TARGET = 56;

/**
 * Why a write control disables in a read-only vault — the ONE sentence for
 * this truth on the phone (v4 handoff §6, §18, issue #711 item M). Two
 * different stub strings used to say the same thing in two places
 * (`PhotoLightboxToolbar`'s bottom-bar reasons and `PhotoLightbox`'s
 * write-refusal panel copy); a member reading both would have no way to know
 * they were the same fact. There is exactly one string now, so the two
 * surfaces can never drift again.
 */
export const READ_ONLY_VAULT_REASON =
  "This vault is read-only for you, so meaning cannot be written into it.";

/** The top bar keeps the exit and the overflow only. */
export const VIEWER_TOP_BAR_HEIGHT = 52;

/**
 * The filmstrip, kept on the phone. Swipe and the strip are the same control
 * approached from two directions; dropping it would make the phone a slideshow.
 */
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
 * Slideshow is a different mode from the viewer, not the viewer with things
 * switched off in the UI: no filmstrip, no info, determinate position (§7.3).
 *
 * A MODEL MUST NOT DESCRIBE CONTROLS THAT DO NOT RENDER. This used to claim
 * `transports: 1, pause: true` while the phone rendered neither — and the one
 * control it DID render wore a pause glyph and exited the slideshow, so the
 * model, the mark and the behaviour were three different stories (issue #711).
 *
 * The phone's slideshow has exactly one top-bar action and it is `Leave`
 * (prototype line 4492). Building the transport is a RECORDED NON-GOAL: Google
 * Photos has no phone slideshow transport either, and a pause control that only
 * exists on one surface is a worse answer than one that exists on neither. The
 * desktop keeps its transport; when the phone earns one, `transports` goes to 1
 * and this comment goes away.
 */
export const SLIDESHOW = {
  filmstrip: false,
  info: false,
  transports: 0,
  pause: false,
} as const;

/**
 * The slideshow's ONE top-bar action, as a single object.
 *
 * Label and effect are read from the SAME value by the control that renders it,
 * which is the structural reason they can no longer disagree — the bug this
 * replaces was a label (a pause glyph) and an effect (exit) that had drifted
 * apart because they were written in two places.
 */
export const SLIDESHOW_ACTION = { effect: "leave", label: "Leave" } as const;

/** The slideshow's title, where the photograph's caption sits in the viewer. */
export const SLIDESHOW_TITLE = "Slideshow";

/**
 * How long one photograph is held. The member-facing meta line PROMISES four
 * seconds (proto 4511), so the number is a promise, not a taste: 3.5s here with
 * "4 seconds a photograph" on screen was the copy lying about the code.
 */
export const SLIDESHOW_INTERVAL_MS = 4000;

/** `12 of 184 · 4 seconds a photograph` — the meta line, which is also the ONLY
 *  place the position index appears now; the viewer's own meta line carries the
 *  capture line instead (proto 4511). */
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

// ---------------------------------------------------------------------------
// What the viewer's top bar says
// ---------------------------------------------------------------------------

/**
 * The top bar carries the photograph's CAPTION over its capture line (§7.1,
 * proto 4510–4511) — never `IMG_4913.HEIC` over `12 of 184`, which is what the
 * phone used to show. A filename is a fact about storage and a position is a
 * fact about the list; neither is a fact about the photograph, and the top bar
 * is the one place the photograph gets to say what it is.
 *
 * The timeline flattens a vault row's `title` column into `filename` (see
 * `timeline-engine.ts`), so the caption and the file name arrive in the same
 * field. A value that still LOOKS like a file name has never been captioned, so
 * it is treated as the last-resort fallback the handoff allows rather than
 * promoted to a caption the member never wrote.
 */
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
 * `30 July 2026 · 17:42 · Lyme Regis` — the second line of the top bar.
 *
 * The mobile twin of the web viewer's `captureLine` (blueprints `viewer.ts`),
 * with the place appended because the phone has no info RAIL beside the stage
 * to carry it. A photograph with no capture time says nothing rather than
 * inventing one; a photograph with no place simply stops after the time.
 */
export function captureLine(input: {
  capturedAt?: string;
  placeName?: string;
}): string {
  const when = input.capturedAt ? new Date(input.capturedAt) : undefined;
  const parts: string[] = [];
  if (when && !Number.isNaN(when.getTime())) {
    parts.push(
      when.toLocaleDateString(undefined, {
        day: "numeric",
        month: "long",
        year: "numeric",
      }),
      when.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
    );
  }
  const place = input.placeName?.trim();
  if (place) parts.push(place);
  return parts.join(" · ");
}

// ---------------------------------------------------------------------------
// The vault a photograph is in
// ---------------------------------------------------------------------------

/**
 * Sharing is a place a photograph is in, not a permission attached to it — and
 * the only fact on the vault record is whether it is the member's OWN
 * (CHANGELOG §H). A vault a member happened to call "Sharing" is still their
 * own, and must still read as reachable by nothing. There is no third kind of
 * place: where a share GOES is a pointer the member owns, so a photograph
 * sitting in the destination reads like one in any other shared vault.
 */
export interface VaultLine {
  /** What the vault CALLS itself — the whole answer to "where is it". */
  value: string;
  /** What being in this vault means. A pure function of `personal`. */
  meaning: string;
}

const PERSONAL_MEANING =
  "Reachable by nothing. Copy it somewhere shared to let someone see it.";

export function vaultLine(personal: boolean, label: string): VaultLine {
  return {
    meaning: personal
      ? PERSONAL_MEANING
      : `Anyone with access to ${label} can see this photograph. Take it out and it stops being shared.`,
    value: label,
  };
}

/** The tile / info marker fires for any vault but the member's own (§4.4). */
export function marksAsElsewhere(personal: boolean): boolean {
  return !personal;
}

// ---------------------------------------------------------------------------
// Zoom
// ---------------------------------------------------------------------------

/**
 * THE rung. One number for every way into a zoom, because a double tap and a
 * `+` that land on different magnifications are two different controls wearing
 * one name: the double tap used to go to 2.5 (`lightbox-gestures.ts`) while the
 * chip went to 2.4, so the readout changed depending on which one you used.
 */
export const ZOOM_RUNG = 2.5;

/** The ceiling the pinch is clamped to. Past this a preview is pixels. */
export const ZOOM_MAX = 5;

/** What one press of `−` / `+` is worth once the ladder is already climbed. */
const ZOOM_STEP = 0.5;

/** `fit` is the floor: the photograph is never smaller than its own frame. */
export const ZOOM_FIT = 1;

/** Scales within this of a rung count as being ON it — a pinch settles on
 *  1.0000001 often enough that an exact comparison would read `100% · drag to
 *  pan` on a photograph that is not zoomed at all. */
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

/** `240%` — the exact magnification, which is the whole point of the readout. */
function zoomPercent(scale: number): string {
  return `${Math.round(scale * 100)}%`;
}

/**
 * "Fit" has to mean fit on a 390px portrait screen as well as a 1420px window,
 * so the box is the constraint and the asset's own ratio decides which axis
 * binds. The ratio comes from the asset record, which is known before the bytes
 * arrive — that is what stops a tile reflowing when they land (§7.1, §14).
 */
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

// ---------------------------------------------------------------------------
// Transports — one slot, three variants
// ---------------------------------------------------------------------------

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

/**
 * `0:08` / `0:24` — mono, tabular, and never a bare float.
 *
 * Rounds rather than truncates, because this is the twin of the web viewer's
 * `clock` (blueprints `viewer.ts`) and the two clients must print the SAME
 * duration for the same recording: a 24.6s video that reads `0:24` on the phone
 * and `0:25` in the browser is one video with two lengths.
 */
export function formatMediaClock(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(whole / 60);
  return `${minutes}:${String(whole % 60).padStart(2, "0")}`;
}

/**
 * The video's resolution name, from the RECORD's pixel height — never a
 * filename or a codec guess. Named after the marketing rungs a member
 * recognises; a height that falls between rungs reads an honest `NNNp` rather
 * than being promoted to a rung it does not clear.
 *
 * Mirrors the web's `videoResolutionLabel` (blueprints `viewer.ts`) rung for
 * rung — the same recording must not be `4K` on one client and `1440p` on the
 * other.
 */
function videoResolutionLabel(asset: { height?: number }): string | null {
  const height = Number(asset.height);
  if (Number.isNaN(height) || height <= 0) return null;
  if (height >= 2160) return "4K";
  if (height >= 1440) return "1440p";
  if (height >= 1080) return "1080p";
  if (height >= 720) return "720p";
  return `${Math.round(height)}p`;
}

/**
 * `video · 4K · 0:24` (proto 4541) — kind, resolution, duration.
 *
 * Each field the record does not carry is OMITTED, never invented: a video with
 * no recorded height reads `video · 0:24`, not `video · ?p · 0:24`, and one
 * with no recorded duration reads `video · 4K` rather than a fabricated `0:00`.
 * The composition rules are the web's `videoKindLabel`, part for part, so both
 * clients label one video identically.
 */
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

// ---------------------------------------------------------------------------
// Where the bytes are
// ---------------------------------------------------------------------------

/**
 * An original that is offloaded by the OS, still on the gateway, or behind a
 * metered connection is each a truthful state — never a broken image (§12).
 */
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

/** Copy for the inline action. One string, so it cannot drift between rows. */
export const LOAD_THE_ORIGINAL = "Load the original";

export function resolveOriginalPlacement(input: {
  hasDeviceOriginal: boolean;
  offloaded?: boolean;
  networkType?: string;
  unlocked?: boolean;
}): OriginalPlacement {
  if (input.hasDeviceOriginal && input.offloaded !== true) return "on-device";
  if (input.hasDeviceOriginal) return "offloaded";
  // A metered connection is a state of the *fetch*, not of the bytes, and it
  // outranks "on the gateway" because it is the thing the member must decide.
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
        text: `Original on ${gatewayName} · a full-quality copy has not been fetched`,
      };
  }
}

/**
 * The paragraph under Facts. It says where the bytes are and what that costs,
 * because "explicit choice" is only honest if the choice is described before it
 * is offered.
 */
export function originalWhereabouts(status: OriginalStatus): string {
  if (status.placement === "on-device")
    return "The original is on this device. Nothing is fetched to open it.";
  if (status.placement === "offloaded")
    return "This device moved the original off to free space. Fetching it back is your choice, and it happens once.";
  if (status.placement === "metered")
    return "The original is on the gateway and this connection is metered. Fetching a full-quality copy is always your choice, never automatic.";
  return "The original is on the gateway. Opening this photograph reads a smaller copy; fetching the full-quality one is your choice.";
}

// ---------------------------------------------------------------------------
// The one status line inside the stage
// ---------------------------------------------------------------------------

/**
 * The phone's teaching line (proto 4637–4639). The desktop shows the bytes here
 * because its gestures are a mouse wheel and a keyboard; the phone's are not
 * discoverable, so the one line the stage owns spends itself saying what the
 * fingers can do — until the bytes have something better to say.
 */
const VIEWER_GESTURE_STATUS =
  "Swipe for the next · pinch or double tap to zoom · swipe up for info";

/** Video's status (proto 4642): what is playing, and which copy of it. */
const VIDEO_STATUS = "Video · playing from the display copy on this device";

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
 * Which of the four things the stage's ONE line says — and in which order.
 *
 * The precedence is deliberate, and it is NOT "the bytes always win", which is
 * what the phone used to do (the byte status was printed unconditionally, so
 * the gesture line and the zoom readout the handoff specifies never appeared at
 * all):
 *
 * 1. **Zoomed** outranks everything. A member holding a magnified photograph
 *    has one question — how far in am I, and how do I get out — and the answer
 *    is time-critical in a way "where are the bytes" is not. The inline action
 *    is dropped here on purpose (proto 4644 blanks it while zoomed): a fetch
 *    that reflows the photograph under a pinched finger is a control firing
 *    into a moving target.
 * 2. **A byte status with something to DO** — an original that is offloaded,
 *    on the gateway, or behind a metered connection. This is the only case
 *    where the member is being offered a choice, and an offer is worth more
 *    than a lesson. Its action routes through the fetch gate.
 * 3. **Video**, which describes the copy that is playing.
 * 4. Otherwise the teaching line. This is where "Original on this device" ends
 *    up — a fact with no action and no cost, which the info sheet also carries
 *    under Facts, so the stage line is better spent on the gestures.
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

// ---------------------------------------------------------------------------
// Gestures
// ---------------------------------------------------------------------------

/**
 * Nothing is reachable by gesture alone (§15). Every gesture the phone adds has
 * a control that does the same job, and the pairing is asserted rather than
 * remembered.
 */
export const GESTURE_POINTER_EQUIVALENTS: Readonly<Record<string, string>> = {
  "double tap": "Zoom to fit",
  // The drag that moves a magnified photograph. Its equivalent is `Fit`: a
  // member who cannot drag gets to the parts they cannot see by returning the
  // whole photograph to the screen, which is the same information by another
  // road. (The desktop's answer is the arrow keys; a phone has none to offer.)
  drag: "Fit to the screen",
  pinch: "Zoom to fit",
  "swipe left": "Next photograph",
  "swipe right": "Previous photograph",
  "swipe up": "Info",
} as const;
