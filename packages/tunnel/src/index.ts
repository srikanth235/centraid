export { createTunnelClient, startLocalProxy, tunnelRequest } from './client.js';
export type {
  LocalProxyHandle,
  TunnelClient,
  TunnelClientOptions,
  TunnelResponse,
} from './client.js';
export type { Connection, PathSnapshot } from './iroh.js';
export { startDesktopTunnel } from './desktop-tunnel.js';
export type {
  ActivePairing,
  DesktopTunnelHandle,
  DesktopTunnelOptions,
  TunnelUpstream,
} from './desktop-tunnel.js';
export { DeviceStore, sanitizeDeviceName } from './device-store.js';
export type { PairedDevice } from './device-store.js';
export { startGatewayEndpoint, GW_PAIR_ALPN } from './gateway-endpoint.js';
export type {
  GatewayEndpointHandle,
  GatewayEndpointOptions,
  GatewayPairRequest,
  GatewayPairResponse,
} from './gateway-endpoint.js';
export { parsePairQrPayload, PAIR_ALPN, TUNNEL_ALPN } from './protocol.js';
export type {
  HeaderMap,
  PairQrPayload,
  PairRequest,
  PairResponse,
  TunnelRequestHeader,
  TunnelResponseHeader,
} from './protocol.js';
