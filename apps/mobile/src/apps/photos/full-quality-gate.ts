// Whether the lightbox may pull an asset's full-quality original.
//
// The original is the largest object in the vault — a 4K video or a 50 MB RAW —
// and the lightbox reaches for it over the gateway. On a metered connection
// that is the user's data allowance, spent without them asking, so the fetch
// needs an explicit tap first.

/**
 * `NetworkState["type"]` values that the user typically pays for by the byte.
 *
 * Compared as strings rather than against `NetworkStateType` so this module
 * stays free of `expo-modules-core` and can be exercised as plain logic;
 * `NetworkStateType` is a string enum whose members are exactly these values.
 */
const METERED_NETWORK_TYPES = new Set(["CELLULAR", "WIMAX"]);

/** Copy for the tap that spends the data. Plain words, no units, no jargon. */
export const LOAD_FULL_QUALITY_LABEL = "Load full quality";

/** Copy for the same control when bytes are already free. */
export const LOAD_ORIGINAL_LABEL = "Original";

export type FullQualityAccess = "granted" | "needs-tap";

export function isMeteredConnection(type: string | undefined): boolean {
  return type !== undefined && METERED_NETWORK_TYPES.has(type);
}

/**
 * `granted` means the original may be fetched as soon as something asks for it;
 * `needs-tap` means the viewer must show the preview and wait for the user.
 *
 * `unlocked` is the user's per-photo consent. It is held next to the asset
 * identity in the viewer, so paging to a different photo asks again — one tap
 * is permission to load *this* photo, not a standing grant over the library.
 */
export function fullQualityAccess(
  networkType: string | undefined,
  unlocked: boolean
): FullQualityAccess {
  if (unlocked || !isMeteredConnection(networkType)) return "granted";
  return "needs-tap";
}
