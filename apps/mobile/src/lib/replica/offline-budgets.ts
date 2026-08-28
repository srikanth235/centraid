/**
 * Native offline budgets are centralized so foreground, background, storage,
 * and the checked household fixture cannot silently drift apart.
 */
/** Not a local budget: the gateway caps a subscription here too (#880). */
export { MAX_MULTIPLEX_REPLICA_SCOPES as MAX_MOUNTED_NATIVE_SCOPES } from "@centraid/core/protocol";

export const MOBILE_REPLICA_BOOTSTRAP_WINDOW = 5_000;
export const THUMBNAIL_SOURCE_BUDGET_BYTES = 128 * 1024 * 1024;
