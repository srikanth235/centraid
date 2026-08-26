// DOWN-direction (gateway → device) fetch gate barrel. Most exports have no
// in-repo caller yet — they ship ahead of their UI by design and knip cannot
// see future callers: DO NOT PRUNE. See pin.ts and policy.ts.

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
  pinnedBytes,
  unpinContent,
} from "./pin";
/** @public */
export type { ConnectionKind, FetchPolicy } from "./policy";
/** @public */
export { defaultFetchPolicy } from "./policy";
