/*
 * Desktop re-export of the shared handshake core (issue #468 K10).
 * Implementation lives in @centraid/client so web and desktop stay lockstep.
 */
export {
  EXPECTED_GATEWAY_VERSION,
  EXPECTED_SCHEMA_EPOCH,
  handshakeGateway,
  judgeGatewayInfo,
  type GatewayInfo,
  type HandshakeResult,
} from '@centraid/client/version-handshake';
