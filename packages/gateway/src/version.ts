/*
 * Gateway identity for the version handshake (issue #289 / #504).
 *
 * Re-exports the single source of truth from `@centraid/protocol`.
 * Do not re-declare GATEWAY_VERSION / GATEWAY_SCHEMA_EPOCH here.
 */

export {
  GATEWAY_VERSION,
  GATEWAY_SCHEMA_EPOCH,
  DEFAULT_GATEWAY_CAPABILITIES,
  type GatewayCapabilities,
} from '@centraid/protocol';
