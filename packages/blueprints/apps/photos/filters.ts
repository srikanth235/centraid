// The two filter menus in the Photos toolbar row, as values (v4 handoff §3,
// §H, CHANGELOG H). No JSX here on purpose: the strip, the toolbar row and
// the tile marker all need the same answers, and a menu component is the
// wrong place to keep them.
//
// THE VAULT FILTER READS THE RECORD, NEVER A NAME. "Is this shared?" is
// `personal === false` — the member's own photographs are the unmarked
// default (§4.4). That is a property of the vault, written at founding and
// untouched by renaming. What the member READS is still `scope.label`, which
// the shell owns and the owner may rename; deriving the fact from a label
// would break the moment they do.
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
 *  menu never shows an unlabelled row — and it names it "Everything", which is
 *  what the timeline is showing when no kind is chosen. "All kinds" described
 *  the MENU (a list of kinds, all of them) rather than the RESULT, and a filter
 *  control resting at its widest setting should read as the thing you are
 *  looking at, not as the mechanism you would use to narrow it. */
export const KIND_LABELS: Readonly<Record<KindFilter, string>> = {
  all: "Everything",
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

/** Sort order for the filter: the member's own scope, then every other place
 *  they can see, each in the order the shell listed them (§H). */
function scopeRank(scope: InlineScope): number {
  return scope.personal === false ? 1 : 0;
}

export function orderedScopes(
  scopes: readonly InlineScope[]
): readonly InlineScope[] {
  return [...scopes]
    .map((scope, index) => ({ scope, index }))
    .sort((a, b) => {
      const rank = scopeRank(a.scope) - scopeRank(b.scope);
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
