/*
 * The channel map, Electron-free (#1020, D-1020-F2). v0's `ipc-core.ts`, at a
 * tenth the size — and the shrinking is the point.
 *
 * v0 carries **41 channels** (`apps/desktop/src/main/ipc-core.ts:4`–`:53`)
 * because the renderer reached the vault over loopback HTTP and every door main
 * had to hold got its own channel. Here the renderer reaches the vault through
 * ONE door — the seat socket, held by main — so the bridge is the socket's
 * shape plus the shell's own business (the window, the seat's lifecycle, the
 * update). v0's own note applies unchanged and is worth restating:
 * *templates, conversation, user prefs, harness detection and automations are
 * not IPC bridges* (`preload-core.ts:157`–`:158`); here they are socket
 * messages, which is the same rule with a different transport.
 *
 * The map is consumed by BOTH sides so they cannot drift, which is why it is in
 * a file neither `electron` nor `net` reaches.
 */

export const Channel = {
  /** A named paged read. */
  SEAT_PAGE: "centraid:seat:page",
  /** Invoke a command. */
  SEAT_COMMAND: "centraid:seat:command",
  /** The enrolled devices. */
  SEAT_DEVICES: "centraid:seat:devices",
  /** The current four states, on demand. */
  SEAT_STATE_GET: "centraid:seat:state:get",
  /** The four states, pushed. */
  SEAT_STATE_EVENT: "centraid:seat:state:event",
  /** One blob's shape, for a thumbnail grid that wants to know before it asks. */
  SEAT_BLOB_STAT: "centraid:seat:blob:stat",
  /** Mint a per-turn capability token for a child process. */
  SEAT_CAPABILITY_MINT: "centraid:seat:capability:mint",
  /** Restart the sidecar after a failure the member chose to retry. */
  SEAT_RETRY: "centraid:seat:retry",
  /** Why the seat is not running, when it is not. */
  SEAT_FAILURE_GET: "centraid:seat:failure:get",
  /** The window's own facts: platform, version, whether this is packaged. */
  HOST_INFO: "centraid:host:info",
  /** Reveal a path in the OS file manager. */
  HOST_REVEAL: "centraid:host:reveal",
  /** The update the watcher last found, if any. */
  UPDATE_STATUS: "centraid:update:status",
  /** Check now, rather than on the four-hour cadence. */
  UPDATE_CHECK: "centraid:update:check",
  /** Relaunch into the update — only ever an ADMITTED, SIGNED download. */
  UPDATE_RELAUNCH: "centraid:update:relaunch",
  /**
   * Pushed when an update is available. The string is
   * `update-watcher.ts`'s own `UPDATE_AVAILABLE_CHANNEL`, which sends on it
   * directly — so it is spelled once, here, rather than twice.
   */
  UPDATE_AVAILABLE: "centraid:update:available",
} as const;

export type ChannelName = (typeof Channel)[keyof typeof Channel];

/** Every channel, for the preload's allowlist and for the drift test. */
export const CHANNELS: readonly ChannelName[] = Object.values(Channel);

/**
 * An app id, validated **before any path join**.
 *
 * Carried verbatim from v0 (`ipc-core.ts:123`–`:154`) including the reason:
 * an appId reaches `shell.openPath`, so the shape is checked at the boundary
 * and not at the join. No leading `_` (those are internal), 1–63 characters of
 * lowercase alphanumerics and hyphens.
 */
const APP_ID = /^[a-z0-9][a-z0-9-]{0,62}$/u;

export function parseRevealableAppId(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  if (!APP_ID.test(raw)) return null;
  return raw;
}

export function assertRevealableAppId(raw: unknown): string {
  const parsed = parseRevealableAppId(raw);
  if (parsed === null) throw new Error("that is not an app id");
  return parsed;
}

/**
 * Whether starting the seat here will pop a credential prompt.
 *
 * v0's `keychainPromptExpected` (`ipc-core.ts:109`–`:121`), carried with its
 * platform table: darwin only when unpackaged (a signed bundle's keychain ACL
 * already admits it), linux always (libsecret prompts per session), Windows
 * DPAPI never. The seat needs the same wrapping key the gateway did, so the
 * prediction is unchanged.
 */
export function keychainPromptExpected(input: {
  platform: string;
  packaged: boolean;
}): boolean {
  switch (input.platform) {
    case "darwin":
      return !input.packaged;
    case "win32":
      return false;
    default:
      return true;
  }
}

/**
 * A named statement, validated against the catalogue the sidecar prints.
 *
 * The renderer cannot compose a read (the catalogue is the sidecar's), but main
 * still refuses an unknown name **before** a round trip: a typo in a blueprint
 * should be a clear error in the window and not a socket frame.
 */
export function isStatementName(raw: unknown): raw is string {
  return typeof raw === "string" && /^[a-z][a-zA-Z]*\.[a-zA-Z]+$/u.test(raw);
}

/** A page limit. Required, bounded, never defaulted — `query.proto`'s rule. */
export function parsePageLimit(raw: unknown): number | null {
  if (typeof raw !== "number" || !Number.isInteger(raw)) return null;
  if (raw <= 0) return null;
  // v0's `MAX_PAGE_ROWS`: a ceiling that clamps and does not refuse.
  return Math.min(raw, 500);
}
