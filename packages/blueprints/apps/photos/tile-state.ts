// What the Tile's four overlay slots say, derived from the record alone (v4
// handoff §4.4, §14). Pure and DOM-free: the tile, the picker, the duplicates
// shelf and the tests all read the SAME answers, and every one of them is
// known BEFORE the bytes arrive — which is the whole point of §14's "a tile
// knows its shape and its colour before its bytes arrive".
//
// COPY IS FINAL. `on the gateway` and `could not decode` are the handoff's
// strings, verbatim.
import type { InlineScope } from "../inline-types.ts";
import { isAudioAsset, isVideoAsset } from "./format.ts";
import { durationLabel, gridSrc } from "./media.ts";
import type { Asset } from "./types.ts";

/**
 * What is true about a tile's bytes.
 *
 *  * `pending` — a paintable source exists and has not landed yet. The tile is
 *    `--skel` at the exact geometry the photograph will occupy.
 *  * `bytes`   — painted.
 *  * `gateway` — there is nothing on this device to paint. NOT a failure: the
 *    original lives on the gateway and fetching it is an explicit choice
 *    (§12). This is the offline / offloaded case, and it says so.
 *  * `failed`  — a real terminal failure. Keeps its geometry, takes a `--net`
 *    border and one line of mono.
 *
 * There is deliberately no fifth value for "vanished": a tile never vanishes.
 */
export type TileMediaState = "pending" | "bytes" | "gateway" | "failed";

/** The state slot's line, or null when the tile has nothing to explain. */
export function stateLine(state: TileMediaState): string | null {
  if (state === "gateway") return "on the gateway";
  if (state === "failed") return "could not decode";
  return null;
}

/**
 * The state a tile STARTS in, from the record. A row with no paintable source
 * is `on the gateway` from the first frame rather than after a failed fetch —
 * a grey mosaic with no explanation is a bug (§14).
 */
export function initialMediaState(asset: Asset): TileMediaState {
  return gridSrc(asset) == null ? "gateway" : "pending";
}

/** The vault slot: a 2px rule in the vault's hue plus its initial. */
export interface TileVault {
  /** The mono initial, drawn at rungs M and L. */
  initial: string;
  /** What the member reads — `scope.label`, which the owner may rename. */
  label: string;
  /** A CSS colour the rule paints. Never Photos' own identity hue on a
   *  control — this is a 2px CONTENT marker, which §2.1 sanctions by name. */
  hue: string;
}

// A vault colour arrives from the shell, so it is narrowed to the two shapes a
// colour can legitimately take here before it reaches a `style` attribute:
// a hex literal, or a reference to one of the design system's own wheel slots.
// Anything else falls back to the app's identity rather than being pasted into
// CSS unchecked.
const HEX = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/u;
const WHEEL = /^var\(--c-[a-z]+\)$/u;
const FALLBACK_HUE = "var(--app-identity)";

export function safeHue(color: unknown): string {
  if (typeof color !== "string") return FALLBACK_HUE;
  const trimmed = color.trim();
  return HEX.test(trimmed) || WHEEL.test(trimmed) ? trimmed : FALLBACK_HUE;
}

/**
 * The vault marker for a tile, or null for the unmarked default.
 *
 * IT FIRES ON `personal`, NEVER ON A NAME (§4.4, §H). Any scope that is not
 * the member's own is marked — the place their shares go included — because
 * "is this only mine?" is the question the marker answers. An owner is free
 * to rename any vault, so a name-derived marker would go wrong the moment
 * they did, and a vault merely CALLED "Sharing" is still only theirs.
 *
 * The solo mount, and any scope whose marker the host did not answer, is
 * unmarked: the distinction does not apply to a member with one library, and
 * a badge on every tile would be noise.
 */
export function vaultMarker(scope: InlineScope | undefined): TileVault | null {
  if (!scope || scope.personal !== false) return null;
  const label = scope.label || "Vault";
  return {
    initial: [...label][0]?.toUpperCase() ?? "?",
    label,
    hue: safeHue(scope.color),
  };
}

/**
 * The kind slot: a video's duration, or `live` for a live photograph. A still
 * has nothing to say here, so it says nothing — the slot is not a badge that
 * every tile must carry.
 */
export function kindLabel(asset: Asset): string | null {
  if (isLiveAsset(asset)) return "live";
  if (!isVideoAsset(asset) && !isAudioAsset(asset)) return null;
  return durationLabel(asset.duration_s);
}

/** A live photograph is a fact the record carries, never a guess off a name. */
export function isLiveAsset(asset: Asset): boolean {
  return (
    asset.kind === "live" ||
    String((asset as { source?: unknown }).source ?? "") === "live"
  );
}

/** The two rung gates §4.4 puts on the slots, as named predicates so the tile
 *  never re-derives "which rung is S again?" inline. */
export function showsKindSlot(rung: number): boolean {
  return rung >= 1; // from rung S up
}
export function showsVaultInitial(rung: number): boolean {
  return rung >= 2; // rungs M and L
}
