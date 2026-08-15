// Centraid — the design system's ELEMENT layer.
//
// `packages/design` has two layers with one owner:
//
//   • the TOKEN layer (`src/*`, the package root export) — the typed values
//     and the emitters that lower them for each surface. It is DOM-free and
//     reachable from Expo through the package's `react-native` condition.
//   • the ELEMENT layer (this subtree, the `@centraid/design/elements`
//     export) — the browser substrate every blueprint app renders on: the
//     custom elements, the status line, confirm-to-act, the popover, the
//     formatters, the refresh discipline, and the attachment flow.
//
// This subpath deliberately carries NO `react-native` condition and is never
// re-exported from `src/index.ts`: the token layer must stay importable by a
// runtime that has no `document`. `native-contract.test.ts` asserts that
// separation rather than trusting it, and this subtree is the only part of
// `src/**` compiled with the DOM lib (`tsconfig.elements.json`).
//
// Importing this module runs the `customElements.define()` calls below, so an
// app that renders `<kit-avatar>`/`<kit-meter>`/`<kit-skeleton>` as JSX gets
// them registered by the same import that gives it `statusLine`.

export { KitElement } from "./base.js";
export type { KitProperties, KitPropertyConfig } from "./base.js";
export { KitAvatar } from "./kit-avatar.js";
export { KitMeter } from "./kit-meter.js";
export { KitSkeleton } from "./kit-skeleton.js";
export { KitStatusLine } from "./kit-status-line.js";

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
