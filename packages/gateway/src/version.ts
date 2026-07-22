/*
 * Gateway identity for the version handshake (issue #289 / #504 / #512).
 *
 * Re-exports the single source of truth from `@centraid/protocol`.
 * Do not re-declare version constants here.
 */

export {
  GATEWAY_VERSION,
  GATEWAY_PROTOCOL_VERSION,
  GATEWAY_MIN_PROTOCOL_VERSION,
  GATEWAY_SCHEMA_EPOCH,
  DEFAULT_GATEWAY_CAPABILITIES,
  type GatewayCapabilities,
} from '@centraid/protocol';
