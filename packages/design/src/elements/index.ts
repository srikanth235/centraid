// Centraid — the design system's ELEMENT layer.
//
// `packages/design` has two layers with one owner:
//
//   • the TOKEN layer (`src/*`, the package root export) — the typed values
//     and the emitters that lower them for each surface. It is DOM-free and
//     reachable from Expo through the package's `react-native` condition.
//   • the ELEMENT layer (this subtree, the `@centraid/design/elements`
//     export) — the browser substrate every blueprint app renders on: the
//     status line, confirm-to-act, the popover, the formatters, the refresh
//     discipline, and the attachment flow.
//
// This subpath deliberately carries NO `react-native` condition and is never
// re-exported from `src/index.ts`: the token layer must stay importable by a
// runtime that has no `document`. `native-contract.test.ts` asserts that
// separation rather than trusting it, and this subtree is the only part of
// `src/**` compiled with the DOM lib (`tsconfig.elements.json`).
//
// There are NO custom elements here any more. #799 retired the last four
// (`kit-avatar`, `kit-meter`, `kit-skeleton`, `kit-status-line`) and the
// `KitElement` base they shared: the presentation primitives are React blocks
// in `packages/blueprints/apps/_shared/`, and the status line is plain DOM
// built by `feedback.ts`. Nothing in this subtree calls
// `customElements.define()`, so importing it registers nothing — it is an
// ordinary module graph of functions.

export { el, h } from "./dom.js";
export {
  armConfirm,
  outcomeMessage,
  readFailed,
  runBulk,
  showSkeleton,
  statusLine,
} from "./feedback.js";
export type {
  StatusLineOptions,
  VaultOutcome,
  VaultOutcomeStatus,
} from "./feedback.js";
export { fmtBytes, fmtMoney, localDayKey, relTime } from "./formatters.js";
export {
  debounce,
  observeWidth,
  onDataChange,
  onFocusRefresh,
  subscribeReadUpdates,
} from "./refresh.js";
export type { ReadSubscription } from "./refresh.js";
export {
  closePopover,
  isPopoverOpen,
  openPopover,
  popItem,
} from "./popover.js";
export {
  fileToDataUri,
  INLINE_ATTACH_BYTES,
  isPendingOffsite,
  renderAttachments,
  stageDerivative,
  stageFileBytes,
  wireAttachInput,
} from "./attachments.js";
export type { Attachment } from "./attachments.js";
export { sha256File, sha256FileStream, StreamingSha256 } from "./sha256.js";
export type { CentraidChangeDetail, CentraidHost, StagedBlob } from "./host.js";
