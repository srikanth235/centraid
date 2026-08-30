// One feedback channel (#707) — never fork it.
export {
  postStatus,
  readStatus,
  subscribeStatus,
} from "@centraid/client/status-channel";
export type {
  StatusAction,
  StatusNote,
  StatusProgress,
} from "@centraid/client/status-channel";
