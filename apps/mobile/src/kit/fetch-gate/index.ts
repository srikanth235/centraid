// Barrel for the DOWN-direction (gateway → device) fetch gate: the shared
// "may I fetch N bytes now?" policy answer, its stated-choice UI contract, and
// pin/unpin for offline retention. See policy.ts for the seam left for the UP
// engine (`kit/transfer/`, a separate workstream) and pin.ts for the honesty
// note on byte accounting.
//
// `@public` below on exports with no consumer yet: `MediaPage.tsx` uses
// `fetchAccess`/`FetchChoicePlaceholder` directly, so those two are exercised
// by a real caller. Everything else ships ahead of its caller by design —
// pin/unpin is API + storage before any UI (Docs is the stated first UI
// consumer), `FetchChoiceChip` is the standalone chip a future caller needs
// without the placeholder wrapper, and `FetchPolicy`/`defaultFetchPolicy`
// exist to be swapped for the UP engine's frame-level policy store once it
// lands. Knip cannot see a caller that doesn't exist yet.

// The standalone chip; no wrapper-less caller yet.
/** @public */
export { FetchChoiceChip } from "./FetchChoice";
export { FetchChoicePlaceholder } from "./FetchChoice";
// The gate's result type; today's only caller narrows inline.
/** @public */
export type { FetchAccess } from "./gate";
export { fetchAccess } from "./gate";
// Kept for callers that only need the boolean, none yet.
/** @public */
export { isMeteredConnection } from "./gate";
// The pin API's own value type; UI is Docs' job, not this pass's.
/** @public */
export type { ContentRef } from "./pin";
// See pin.ts: bytes accounting is honestly unwired, not unused.
/** @public */
export type { PinnedBytesAnswer } from "./pin";
// Pin/unpin ships as API + storage; Docs is the first UI consumer.
/** @public */
export {
  hydratePinnedContent,
  isPinned,
  listPinnedContent,
  pinContent,
  pinnedBytes,
  unpinContent,
} from "./pin";
// The seam a `kit/transfer/`-backed `FetchPolicy` will replace.
/** @public */
export type { ConnectionKind, FetchPolicy } from "./policy";

// The default implementation of the seam above.
/** @public */
export { defaultFetchPolicy } from "./policy";
