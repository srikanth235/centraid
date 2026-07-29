/**
 * Native offline budgets are centralized so foreground, background, storage,
 * and the checked household fixture cannot silently drift apart.
 */
export const MAX_MOUNTED_NATIVE_SCOPES = 4;
export const MOBILE_REPLICA_BOOTSTRAP_WINDOW = 5_000;
export const THUMBNAIL_SOURCE_BUDGET_BYTES = 128 * 1024 * 1024;
