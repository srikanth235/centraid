/*
 * Gateway identity for the version handshake (#289 / #504 / #512).
 *
 * Re-exports the single source of truth from `@centraid/core/protocol`.
 * Do not re-declare version constants here.
 */

export {
  GATEWAY_VERSION,
  GATEWAY_PROTOCOL_VERSION,
  GATEWAY_MIN_PROTOCOL_VERSION,
} from "@centraid/core/protocol";
