export {
  GATEWAY_VERSION,
  GATEWAY_PROTOCOL_VERSION,
  GATEWAY_MIN_PROTOCOL_VERSION,
  GATEWAY_SCHEMA_EPOCH,
} from './version.js';
/** Client-facing aliases (product display / protocol floor). */
export { GATEWAY_VERSION as EXPECTED_GATEWAY_VERSION } from './version.js';
export { GATEWAY_PROTOCOL_VERSION as EXPECTED_PROTOCOL_VERSION } from './version.js';
export { GATEWAY_SCHEMA_EPOCH as EXPECTED_SCHEMA_EPOCH } from './version.js';

export {
  DEFAULT_GATEWAY_CAPABILITIES,
  isGatewayCapabilities,
  type GatewayCapabilities,
} from './capabilities.js';

export {
  GATEWAY_PLANE_PREFIX,
  VAULT_PLANE_PREFIX,
  APPS_PLANE_PREFIX,
  TOOL_PLANE_PREFIX,
  WEB_PLANE_PREFIX,
  ROUTES,
  ROUTE_PATHS,
  vaultConnectionAuthorizePath,
  vaultConnectionPath,
  type RouteName,
} from './routes.js';

export {
  judgeGatewayInfo,
  handshakeGateway,
  buildGatewayInfoPayload,
  readProtocolFromInfo,
  protocolsCompatible,
  type GatewayInfo,
  type HandshakeResult,
} from './handshake.js';
