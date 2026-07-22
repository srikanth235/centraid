/*
 * Version handshake (issue #289 decision 8 / #468 K10 / #504).
 *
 * Re-exports the pure wire core from `@centraid/protocol` so desktop + web
 * share one version/epoch source with the gateway and CLI. The former
 * "MUST track" mirror is gone.
 */

export {
  EXPECTED_GATEWAY_VERSION,
  EXPECTED_SCHEMA_EPOCH,
  GATEWAY_VERSION,
  GATEWAY_SCHEMA_EPOCH,
  judgeGatewayInfo,
  handshakeGateway,
  type GatewayInfo,
  type HandshakeResult,
  type GatewayCapabilities,
} from '@centraid/protocol';
