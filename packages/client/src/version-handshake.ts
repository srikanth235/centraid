/*
 * Version handshake (issue #289 decision 8 / #468 K10 / #504 / #512).
 *
 * Re-exports the pure wire core from `@centraid/protocol` so desktop + web
 * share one product + protocol source with the gateway and CLI.
 * Runtime connect gates on protocol only (product version is display).
 */

export {
  EXPECTED_GATEWAY_VERSION,
  EXPECTED_PROTOCOL_VERSION,
  EXPECTED_SCHEMA_EPOCH,
  GATEWAY_VERSION,
  GATEWAY_PROTOCOL_VERSION,
  GATEWAY_MIN_PROTOCOL_VERSION,
  GATEWAY_SCHEMA_EPOCH,
  judgeGatewayInfo,
  handshakeGateway,
  protocolsCompatible,
  type GatewayInfo,
  type HandshakeResult,
  type GatewayCapabilities,
} from '@centraid/protocol';
