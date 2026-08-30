// Re-export path for `status-channel.ts`, the one feedback channel (#883).
export {
  clearStatus,
  postStatus,
  readRouteHealth,
  readStatus,
  resetStatus,
  setRouteHealth,
  showUndoStatus,
  subscribeStatus,
} from "../../status-channel.js";
export type { RouteHealthNote } from "../../status-channel.js";
