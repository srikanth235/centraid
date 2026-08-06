// Everything the stage knows WITHOUT a DOM (v4 handoff §7.1-§7.4).
//
// The viewer, the slideshow and the editor are three modes of one surface, and
// almost every rule the handoff puts on them is a pure question about a
// record, a pixel width or a zoom factor:
//
//   * "are the actions labelled?" is a function of the BAR's width, not of the
//     surface (§7.1, §15) — so it is a number here, not a `@media` query;
//   * "what does the zoom readout say?" is arithmetic;
//   * "which transport does this asset carry?" is a fact about the row;
//   * "where does the original live?" is a fact about custody.
//
// Keeping them here means the tests read the same answers the components do,
// and no rule is expressed twice.
//
// COPY IS FINAL. Every string below is the handoff's, verbatim. It lives with
// the rule that selects it rather than in view-copy.ts, whose shape is a
// per-shelf table keyed by `ShelfId` — the stage has no shelf.
//
// The storage noun never appears in a user-visible string: what a member reads
// for a vault is `scope.label`, which the shell owns and the owner may rename.
import { isAudioAsset, isVideoAsset } from "./format.ts";
import { isLiveAsset } from "./tile-state.ts";
import type { Asset } from "./types.ts";

/**
 * Below this many pixels OF BAR the viewer's actions go icon-only, with the
 * label carried as `aria-label` and `title` (§7.1, §15).
 *
 * IT IS A FUNCTION OF AVAILABLE WIDTH, NOT OF SURFACE. The desktop shows
 * labels; the PWA at 1090 does not, because its bar is narrower once the stem
 * and the info rail have taken their share. Deriving this from a viewport
 * breakpoint would label a 900px window's bar and strip a 1400px window's the
 * moment the info rail opened.
 */
export const LABEL_BREAKPOINT = 840;

/** Are the viewer's actions labelled at this bar width? */
export function labelsVisible(barWidth: number): boolean {
  return barWidth >= LABEL_BREAKPOINT;
}

/** Un-zoomed. Not a magic 1: the fit state is a named rung of the ladder. */
export const FIT = 1;

/**
 * The zoom ladder. Fit, then five steps to 4×. Discrete rungs rather than a
 * continuous pinch factor because every step has to be reachable from a
 * pointer too — §15's "nothing is reachable by gesture alone".
 */
export const ZOOM_STEPS: readonly number[] = [FIT, 1.5, 2, 2.4, 3, 4];

export function isZoomed(scale: number): boolean {
  return scale > FIT;
}

/** The next rung up, or the top one. */
export function zoomIn(scale: number): number {
  return ZOOM_STEPS.find((step) => step > scale) ?? ZOOM_STEPS.at(-1) ?? FIT;
}

/** The next rung down, or fit. */
export function zoomOut(scale: number): number {
  let below = FIT;
  for (const step of ZOOM_STEPS) if (step < scale) below = step;
  return below;
}

/**
 * The exact readout a zoomed stage carries (§7.1): `240% · drag to pan`.
 *
 * EXACT, not approximate, and not a slider position — the member is being told
 * what they are looking at, and "drag to pan" is the only place the pan
 * gesture is named. A percentage is a numeric, so it renders in the mono role
 * with tabular figures (§18); the rounding happens here so the string and the
 * transform can never disagree.
 */
export function zoomReadout(scale: number): string {
  return `${Math.round(scale * 100)}% · drag to pan`;
}

/** The un-zoomed chip's label (§7.1). Lowercase, deliberately: it is a state,
 *  not a command — the `+` beside it is the command. */
export const FIT_CHIP = "fit";

/** The zoomed control's third button — the way back to fit. */
export const FIT_ACTION = "Fit";

/**
 * The asset's aspect ratio, from the RECORD. Known before the bytes arrive,
 * which is what lets the stage reserve the right box on the first frame (§14).
 * A row with no dimensions is square rather than absent: a stage that
 * collapsed to nothing and then jumped would reflow, and nothing reflows.
 */
export function assetRatio(asset: Asset): number {
  const w = Number(asset.width);
  const h = Number(asset.height);
  return w > 0 && h > 0 ? w / h : 1;
}

/**
 * The stage image's PREFERRED width (§7.1): `targetHeight × ratio`.
 *
 * Preferred, never imposed — the element also carries `max-width: 100%` and
 * `max-height: 100%`, so "fit" means fit on a 390px portrait screen as well as
 * in a 1420px window. This number only says which of the two constraints the
 * photograph would like to be bound by.
 */
export function preferredWidth(targetHeight: number, ratio: number): number {
  return Math.round(targetHeight * ratio);
}

/** The three transport variants (§7.1). One slot, three fillings. */
export type TransportKind = "video" | "audio" | "live";

/** Which transport this asset carries, or null for a still. */
export function transportKind(asset: Asset): TransportKind | null {
  if (isLiveAsset(asset)) return "live";
  if (isVideoAsset(asset)) return "video";
  if (isAudioAsset(asset)) return "audio";
  return null;
}

/** The micro-caps kind label beside each transport. Final copy. */
export const TRANSPORT_LABELS: Readonly<Record<TransportKind, string>> = {
  video: "video",
  audio: "audio",
  live: "live photo",
};

/**
 * The video's resolution name, from the RECORD's pixel height — never a
 * filename or a codec guess. Named after the common marketing rungs (§7.1's
 * `video · 4K · 0:24`) because that is what a member recognizes; a row whose
 * height falls between named rungs still gets an honest `NNNp` rather than
 * being rounded up to a rung it does not clear.
 */
export function videoResolutionLabel(asset: Asset): string | null {
  const height = Number(asset.height);
  if (Number.isNaN(height) || height <= 0) return null;
  if (height >= 2160) return "4K";
  if (height >= 1440) return "1440p";
  if (height >= 1080) return "1080p";
  if (height >= 720) return "720p";
  return `${Math.round(height)}p`;
}

/**
 * The video stage's kind label (§7.1): `video · 4K · 0:24` — kind,
 * resolution, duration. Each field the record does not carry is OMITTED,
 * never invented: a video with no recorded height reads `video · 0:24`, not
 * `video · ?p · 0:24`, and a video with no recorded duration reads
 * `video · 4K` rather than a fabricated `0:00`.
 */
export function videoKindLabel(asset: Asset): string {
  const parts = ["video"];
  const resolution = videoResolutionLabel(asset);
  if (resolution) parts.push(resolution);
  const duration = Number(asset.duration_s);
  if (duration > 0) parts.push(clock(duration));
  return parts.join(" · ");
}

/** `0:08` — the mono position/duration format the transport carries (§7.1). */
export function clock(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(total / 60);
  return `${minutes}:${String(total % 60).padStart(2, "0")}`;
}

/** A determinate track never divides by zero and never runs past its end. */
export function trackFraction(elapsed: number, duration: number): number {
  if (Number.isNaN(duration) || duration <= 0) return 0;
  return Math.max(0, Math.min(1, elapsed / duration));
}

/**
 * The capture line under the viewer's title (§7.1): `30 July 2026 · 17:42`.
 *
 * A numeric, so it renders in the mono role — which is also what keeps it
 * readable under RTL, since that role declares `direction: ltr` and
 * `unicode-bidi: isolate` on itself (§2.2). A row with no capture time says
 * nothing rather than inventing one.
 */
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

/** The capture date of an asset in long form, or null when the record has
 *  none (or an unparseable one). Null is the honest answer, not a fallback. */
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

/**
 * The editor's meta line (proto 4511): where the photograph being edited came
 * from. Four sentences, one per state of what is actually KNOWN — the line
 * never says more than the record does.
 *
 * Lineage is read, not assumed (issue #711). An edited copy carries
 * `source_asset_id` and is dated the day it was SAVED, so reading its
 * `captured_at` back as a capture date would state a falsehood about when the
 * shutter fired. When the copy's source is on hand its capture date is what
 * the line names; when it is not (the library page it sits on is a bounded
 * window, so the source may simply not be loaded) the line says an edit is
 * what this is and stops there. `source` is matched by id before it is
 * trusted — a mismatched row is no source at all.
 */
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

/** The stage's own status line: what is true about the BYTES (§7.1). */
export interface OriginStatus {
  text: string;
  /** The inline text action, where there is something to do about it. */
  action?: string;
}

/**
 * Where the original currently lives, in the member's words.
 *
 * Loading a full-quality original over a metered connection is ALWAYS an
 * explicit choice (§7.1), so this never fetches anything — it says what is
 * true and offers the verb. A photograph whose bytes are already on the device
 * has nothing to explain, and says nothing rather than reassuring the member
 * about a non-problem.
 */
export function originStatus(
  asset: Asset,
  gatewayName: string
): OriginStatus | null {
  // A playing video names what it is playing FROM, ahead of the custody
  // story below (§7.1's precedence: video beats the default origin line).
  // The native transport already streams the display copy — the byte that
  // is actually on screen — so this is what is true right now, not a
  // custody forecast the member would have to reconcile with a moving
  // scrubber.
  if (isVideoAsset(asset)) {
    return { text: "Video · playing from the display copy on this device" };
  }
  const custody = String(asset.custody_state ?? "");
  if (custody === "remote-only") {
    return {
      text: `Original on ${gatewayName} · a full-quality copy has not been fetched`,
      action: "Load the original",
    };
  }
  if (custody === "missing") {
    return { text: `The original is not on ${gatewayName} or on this device` };
  }
  // A preview is standing in for an original that has not been fetched.
  if (asset.preview_uri && !asset.content_uri) {
    return {
      text: `Original on ${gatewayName} · a full-quality copy has not been fetched`,
      action: "Load the original",
    };
  }
  return null;
}

/** The gateway's name when the host has not told us one. Never invented as a
 *  hostname — "the gateway" is true on every deployment. */
export const DEFAULT_GATEWAY_NAME = "the gateway";

/**
 * One paragraph on where the original lives, for the info panel (§7.2) — the
 * per-copy provenance line (issue #712 P6a).
 *
 * WHAT IT MAY SAY, AND WHAT IT MAY NOT. The only per-photograph custody fact
 * an app can read is `blob.custody_state` (the five-value projection in
 * packages/vault/src/blob/custody-state.ts, granted in app.json and joined
 * onto every asset row by queries/_shared.ts). `blob_replica` — the table that
 * knows WHICH remote object, in which bucket, under which class — is NOT a
 * registered logical entity (packages/vault/src/schema/tables.ts registers
 * only `custody_state` and `custody_rollup` under `blob`), so naming an
 * individual copy's destination here would be an invention, not a read. The
 * paragraph therefore answers "where are its copies" at exactly the
 * granularity the vault asserts: this disk, the gateway, both, or neither.
 *
 * A TABLE, AND TOTAL. The previous shape was three `if`s and a trailing
 * `return` that fired for THREE different worlds — `local-only`,
 * `pending-offsite`, and an ABSENT custody state (the sweep has never run, or
 * this content item has no row) — and asserted the same location claim for
 * all of them. The last of those is the defect: the vault had made no claim
 * at all and the panel made one anyway. Each state now has its own sentence,
 * and "nobody has looked" is one of them.
 */
const ORIGIN_PARAGRAPHS: Record<string, (gatewayName: string) => string> = {
  replicated: (gateway) =>
    `The original is on this device and on ${gateway}. Either copy can serve it, so losing one does not lose the photograph.`,
  "remote-only": (gateway) =>
    `The original is on ${gateway} and not on this device. Opening it at full quality fetches it, which is why that is a choice and not something this screen does for you.`,
  missing: () =>
    `No copy of the original can be found. The record — the caption, the date, the albums it is in — is still here, and it is what a restored copy would attach to.`,
  // Distinct from local-only: an upload is OUTSTANDING (a `blob_outbox` row),
  // which is a different fact from "there is nowhere to copy it to".
  "pending-offsite": (gateway) =>
    `The original is on this device only. A copy to ${gateway} is queued and has not finished, so for now this device is the one place it exists.`,
  "local-only": (gateway) =>
    `The original is on this device and nowhere else. Nothing is queued to copy it to ${gateway}, so losing this device loses the photograph.`,
};

export function originParagraph(asset: Asset, gatewayName: string): string {
  const line = ORIGIN_PARAGRAPHS[String(asset.custody_state ?? "")];
  // No row, no claim. The gateway's standing blob sweep is what fills
  // `blob_custody_state`; before it has run there is nothing to report, and
  // saying so is the only honest sentence available.
  if (!line)
    return `Where the original is kept has not been checked yet. ${gatewayName} works this out on its own schedule; until it has, this panel will not guess.`;
  return line(gatewayName);
}

/** The viewer's six actions, in the handoff's order (§7.1, desktop bar). */
export const VIEWER_ACTIONS = [
  "favorite",
  "edit",
  "info",
  "sharing",
  "download",
  "slideshow",
] as const;
export type ViewerActionId = (typeof VIEWER_ACTIONS)[number];

/**
 * The phone's bottom bar: five 56px targets where a thumb is (§7.1, §D).
 *
 * SAME NAMES, SAME MARKS, A DIFFERENT ORDER — the thumb-reachable middle
 * belongs to the two the member presses most. Trash appears here and not on
 * the desktop bar because the desktop reaches it from the info panel, which
 * the phone hides behind a sheet.
 */
export const PHONE_ACTIONS = [
  "sharing",
  "favorite",
  "info",
  "edit",
  "trash",
] as const;
export type PhoneActionId = (typeof PHONE_ACTIONS)[number];

/** Every label a viewer action can carry. Final copy; `Copy to Sharing` is a
 *  DESTINATION, never the verb `Share` with an invisible effect (§H). */
export const ACTION_LABELS: Readonly<
  Record<ViewerActionId | PhoneActionId, string>
> = {
  favorite: "Favorite",
  edit: "Edit",
  info: "Info",
  sharing: "Copy to Sharing",
  download: "Download",
  slideshow: "Slideshow",
  trash: "Trash",
};

/** The slideshow's status line (§7.3). Verbatim. */
export const SLIDESHOW_STATUS =
  "Esc leaves · the viewer keeps the photograph you stopped on";

/** The editor's commit, worded as what it DOES (§7.4). */
export const SAVE_AS_NEW = "Save as a new photograph";

/** The explanation that sits beside it, at the point of decision (§7.4). */
export const SAVE_AS_NEW_EXPLANATION =
  "Saving writes a new photograph dated today, with this one recorded as its source. The original is not touched, and nothing is overwritten.";

/** The editor's tool row (§7.4). Crop and rotate only — no filters, no
 *  adjustments: an edit this app cannot express non-destructively is an edit
 *  it does not offer. */
export const EDITOR_RATIOS = ["Original", "Square", "3:2"] as const;
export type EditorRatio = (typeof EDITOR_RATIOS)[number];

/** A named ratio as a number, or null for "whatever the frame already is". */
export function ratioValue(ratio: EditorRatio): number | null {
  if (ratio === "Square") return 1;
  if (ratio === "3:2") return 3 / 2;
  return null;
}

/**
 * The largest centred crop of `ratio` that fits a frame of `frameRatio`,
 * in FRACTIONS of that frame — the geometry `Square` and `3:2` snap to.
 */
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

/**
 * What the info panel says a photograph's place means (§7.2). The scope's own
 * LABEL carries the name — that is the whole answer to "where is it" — and
 * this is only the consequence of being there.
 *
 * There are two consequences, not three, because there are only two facts: it
 * is the member's own place, or it is not (§H). Where a share GOES is a
 * pointer the member owns, not a third kind of place, so it never appears
 * here — a photograph that happens to sit in the destination reads exactly
 * like a photograph in any other shared place, which is the truth.
 */
export const PERSONAL_MEANING =
  "reachable by nothing. Copy it somewhere shared to let someone see it.";
export const SHARED_MEANING =
  "anyone holding a grant here can see it. Take it out and it stops being shared.";

/** The consequence line for the scope a photograph is in. Unknown reads as the
 *  member's own — the truthful answer for a solo mount. */
export function scopeMeaning(personal: boolean | undefined): string {
  return personal === false ? SHARED_MEANING : PERSONAL_MEANING;
}
