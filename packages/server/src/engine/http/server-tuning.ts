import type http from "node:http";

export const GATEWAY_KEEP_ALIVE_TIMEOUT_MS = 60_000;
export const GATEWAY_HEADERS_TIMEOUT_MS = 65_000;
export const GATEWAY_REQUEST_TIMEOUT_MS = 30 * 60_000;
export const GATEWAY_MAX_CONNECTIONS = 256;
export const GATEWAY_SHUTDOWN_GRACE_MS = 2_000;

export function tuneGatewayHttpServer(server: http.Server): void {
  server.keepAliveTimeout = GATEWAY_KEEP_ALIVE_TIMEOUT_MS;
  server.headersTimeout = GATEWAY_HEADERS_TIMEOUT_MS;
  server.requestTimeout = GATEWAY_REQUEST_TIMEOUT_MS;
  server.maxConnections = GATEWAY_MAX_CONNECTIONS;
}
