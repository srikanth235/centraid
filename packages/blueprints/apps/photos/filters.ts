// The two filter menus in the Photos toolbar row, as values (v4 handoff §3,
// §H, CHANGELOG H). No JSX here on purpose: the strip, the toolbar row, the
// tile marker and the share destination all need the same answers, and a menu
// component is the wrong place to keep them.
//
// THE VAULT FILTER READS THE RECORD, NEVER A NAME. Two facts, and they are
// different KINDS of fact:
//
//   * "is this shared?" is `personal === false` — the member's own
//     photographs are the unmarked default (§4.4). That is a property of the
//     vault, written at founding and untouched by renaming.
//   * WHERE a share goes is a POINTER the member owns (`shareTargetId()` in
//     scopes.ts), because a member may want to share into several vaults. It
//     is not a property of any vault, so no scope row carries it, and nothing
//     here goes looking for "the sharing vault".
//
// What the member READS is still `scope.label`, which the shell owns and the
// owner may rename. Deriving either fact from a label would break the moment
// they do.
import type { InlineScope } from "../inline-types.ts";
import type { Asset } from "./types.ts";

/** The kind filter's rungs (§16). `all` is the resting state, not a value. */
export const KINDS = [
  "all",
  "photo",
  "video",
  "audio",
  "scan",
  "screenshot",
  "selfie",
] as const;
export type KindFilter = (typeof KINDS)[number];

/** Final copy, from the handoff. `all` names the resting state out loud so the
 *  menu never shows an unlabelled row. */
export const KIND_LABELS: Readonly<Record<KindFilter, string>> = {
  all: "All kinds",
  photo: "Photographs",
  video: "Videos",
  audio: "Audio",
  scan: "Scans",
  screenshot: "Screenshots",
  selfie: "Selfies",
};

/**
 * Does `asset` belong to `kind`? The three derived kinds are facts about how a
 * photograph came to be, which the record carries as a source; where it does
 * not, the asset is simply not one of them. Nothing is guessed from a filename.
 */
export function matchesKind(asset: Asset, kind: KindFilter): boolean {
  if (kind === "all") return true;
  const media = String(asset.media_type ?? "");
  if (kind === "video") return media.startsWith("video/");
  if (kind === "audio") return media.startsWith("audio/");
  if (kind === "photo") return media.startsWith("image/");
  return String((asset as { source?: unknown }).source ?? "") === kind;
}

export function filterByKind(list: Asset[], kind: KindFilter): Asset[] {
  return kind === "all" ? list : list.filter((a) => matchesKind(a, kind));
}

/** Any scope but the member's own — the tile marker's rule and the answer to
 *  "is this shared?" (§4.4, §H). A scope whose marker is unknown reads as the
 *  member's own: withholding the hint is harmless, marking everything is not. */
export function isSharedScope(scope: InlineScope | undefined): boolean {
  return scope?.personal === false;
}

/**
 * Where a share lands: the member's POINTER, resolved against what is mounted
 * here. Undefined when nothing is pointed at, and equally undefined when the
 * pointer names a place this device cannot reach — the caller distinguishes
 * the two and says which, rather than doing nothing (sharing.ts).
 */
export function shareDestination(
  scopes: readonly InlineScope[],
  targetId: string | undefined
): InlineScope | undefined {
  if (targetId === undefined) return undefined;
  return scopes.find((scope) => scope.id === targetId);
}

/** Sort order for the filter: the member's own scope, then wherever their
 *  shares go, then every other audience they belong to, each in the order the
 *  shell listed them (§H). */
function scopeRank(scope: InlineScope, targetId: string | undefined): number {
  if (scope.personal !== false) return 0;
  return scope.id === targetId ? 1 : 2;
}

export function orderedScopes(
  scopes: readonly InlineScope[],
  targetId?: string
): readonly InlineScope[] {
  return [...scopes]
    .map((scope, index) => ({ scope, index }))
    .sort((a, b) => {
      const rank = scopeRank(a.scope, targetId) - scopeRank(b.scope, targetId);
      return rank === 0 ? a.index - b.index : rank;
    })
    .map((entry) => entry.scope);
}

/**
 * `vaultsOn` as a predicate. An empty set means "every one" rather than
 * "none": the resting state of a filter is the unfiltered view, and a member
 * who has never opened the menu must see their whole timeline.
 */
export function scopeIsOn(
  vaultsOn: ReadonlySet<string>,
  scopeId: string | null | undefined
): boolean {
  return vaultsOn.size === 0 || vaultsOn.has(scopeId ?? "");
}

/**
 * The single scope a CREATING write should land in, or null for "wherever the
 * shell puts new things". One vault switched on is an unambiguous target;
 * "all", or several, is not, so the write falls back to the member's own.
 */
export function writeScopeFor(vaultsOn: ReadonlySet<string>): string | null {
  return vaultsOn.size === 1 ? [...vaultsOn][0]! : null;
}
