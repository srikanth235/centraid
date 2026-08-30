// DOWN-direction (gateway → device) pin/download engine barrel (#883 C6).
// `ensureOfflineContent` is THE verb: pin → download → local read → eviction
// exemption, shared by Docs' "available offline" and Photos' "download the
// original". The pieces below it are exported for the surfaces that need one
// half (a storage screen wants totals, not a download).

/** @public */
export { FetchChoiceChip } from "./FetchChoice";
export { FetchChoicePlaceholder } from "./FetchChoice";
/** @public */
export type { FetchAccess } from "./gate";
export { fetchAccess } from "./gate";
/** @public */
export { isMeteredConnection } from "./gate";
/** @public */
export type { ContentRef } from "./pin";
/** @public */
export type { PinnedBytesAnswer } from "./pin";
/** @public */
export {
  hydratePinnedContent,
  isPinned,
  listPinnedContent,
  pinContent,
  unpinContent,
} from "./pin";
/** @public */
export { currentNetworkType } from "./network";
/** @public */
export type { ConnectionKind, FetchPolicy } from "./policy";
/** @public */
export { defaultFetchPolicy } from "./policy";
/** @public */
export type { ContentEvictionPlan, StoredContentEntry } from "./eviction";
export { planContentEviction } from "./eviction";
/** @public */
export {
  enforceOfflineContentBudget,
  hydrateOfflineContent,
  OFFLINE_CONTENT_BUDGET_BYTES,
  offlineContentBytes,
  offlineContentUri,
  pinnedBytes,
  removeOfflineContentScope,
  storedContentEntries,
} from "./content-store";
/** @public */
export type { OfflineContentOutcome } from "./download";
export {
  ensureOfflineContent,
  OFFLINE_FETCH_FAILED_REASON,
  OFFLINE_UNREACHABLE_REASON,
  releaseOfflineContent,
} from "./download";
