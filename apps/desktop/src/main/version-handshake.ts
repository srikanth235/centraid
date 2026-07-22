/*
 * Desktop re-export of the shared handshake core (issue #468 K10 / #512).
 * Implementation lives in @centraid/client so web and desktop stay lockstep.
 */
export {
  EXPECTED_GATEWAY_VERSION,
  EXPECTED_PROTOCOL_VERSION,
  EXPECTED_SCHEMA_EPOCH,
  GATEWAY_MIN_PROTOCOL_VERSION,
  handshakeGateway,
  judgeGatewayInfo,
  protocolsCompatible,
  type GatewayInfo,
  type HandshakeResult,
} from '@centraid/client/version-handshake';
