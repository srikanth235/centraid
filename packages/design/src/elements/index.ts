// ELEMENT layer; never re-exported from src/index.ts, no react-native
// condition — tokens stay DOM-free (native-contract.test.ts asserts it).

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
