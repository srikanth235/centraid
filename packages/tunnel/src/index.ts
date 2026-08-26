export {
  createTunnelClient,
  endpointIdForSecret,
  endpointTicketFor,
  inspectEndpointTicket,
  startLocalProxy,
  tunnelRequest,
} from "./client.js";
export type {
  EndpointTicketHint,
  LocalProxyHandle,
  TunnelClient,
  TunnelClientOptions,
  TunnelResponse,
} from "./client.js";
export type { Connection, PathSnapshot } from "./iroh.js";
export {
  startDesktopTunnel,
  startPreferredDesktopTunnel,
} from "./desktop-tunnel.js";
export { startNativeDesktopTunnel } from "./native-relay.js";
export type {
  ActivePairing,
  DesktopTunnelHandle,
  DesktopTunnelOptions,
  TunnelUpstream,
} from "./desktop-tunnel.js";
export { DeviceStore, sanitizeDeviceName } from "./device-store.js";
export type { PairedDevice } from "./device-store.js";
export { EndpointSecretError, loadEndpointSecret } from "./endpoint-secret.js";
export type {
  EndpointSecretCorruptionPolicy,
  EndpointSecretPersistence,
  LoadEndpointSecretOptions,
} from "./endpoint-secret.js";
export { startGatewayEndpoint, GW_PAIR_ALPN } from "./gateway-endpoint.js";
export type {
  GatewayEndpointHandle,
  GatewayEndpointOptions,
  GatewayPairRequest,
  GatewayPairResponse,
  GatewayPairVault,
} from "./gateway-endpoint.js";
export {
  DEVICE_IDENTITY_HEADER,
  DEVICE_PROOF_HEADER,
  isPeerPlaneTarget,
  parsePairQrPayload,
  PAIR_ALPN,
  PEER_ENDPOINT_HEADER,
  PEER_LINK_ALPN,
  PEER_PLANE_PREFIX,
  PEER_PROOF_HEADER,
  PEER_VAULT_HEADER,
  TUNNEL_ALPN,
  TUNNEL_FORWARDED_HEADER,
} from "./protocol.js";
export { createTokenBucket, PEER_PLANE_BUDGET } from "./peer-budget.js";
export type { TokenBucket, TokenBucketOptions } from "./peer-budget.js";
export type {
  HeaderMap,
  PairQrPayload,
  PairRequest,
  PairResponse,
  TunnelRequestHeader,
  TunnelResponseHeader,
} from "./protocol.js";
