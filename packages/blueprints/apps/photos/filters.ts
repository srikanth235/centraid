// Photos toolbar filters as values. Vault filter reads `personal === false`, never a name (§4.4).
import type { InlineScope } from "../inline-types.ts";
import type { Asset } from "./types.ts";

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

/** Resting kind is "Everything" (the result), not "All kinds" (the menu). */
export const KIND_LABELS: Readonly<Record<KindFilter, string>> = {
  all: "Everything",
  photo: "Photographs",
  video: "Videos",
  audio: "Audio",
  scan: "Scans",
  screenshot: "Screenshots",
  selfie: "Selfies",
};

/** Derived kinds come from `source`; never guess from a filename. */
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

/** Unknown marker reads as own: marking everything is not harmless. */
export function isSharedScope(scope: InlineScope | undefined): boolean {
  return scope?.personal === false;
}

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

/** Empty `vaultsOn` is "every one", not "none". */
export function scopeIsOn(
  vaultsOn: ReadonlySet<string>,
  scopeId: string | null | undefined
): boolean {
  return vaultsOn.size === 0 || vaultsOn.has(scopeId ?? "");
}

/** One vault on is the write target; "all" or several is `null` (member's own). */
export function writeScopeFor(vaultsOn: ReadonlySet<string>): string | null {
  return vaultsOn.size === 1 ? [...vaultsOn][0]! : null;
}
