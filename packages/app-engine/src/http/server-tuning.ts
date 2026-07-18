import type http from 'node:http';

export const GATEWAY_KEEP_ALIVE_TIMEOUT_MS = 60_000;
export const GATEWAY_HEADERS_TIMEOUT_MS = 65_000;
export const GATEWAY_REQUEST_TIMEOUT_MS = 120_000;
export const GATEWAY_MAX_CONNECTIONS = 256;

/** Shared low-RAM listener policy for the API and dedicated PWA origins (#456 R3). */
export function tuneGatewayHttpServer(server: http.Server): void {
  // Health pollers and interactive clients reuse one socket across ordinary
  // think time instead of reconnecting against Node's 5 s default.
  server.keepAliveTimeout = GATEWAY_KEEP_ALIVE_TIMEOUT_MS;
  // Headers must remain slightly wider than keep-alive or a reused socket can
  // be reaped while its next request is arriving.
  server.headersTimeout = GATEWAY_HEADERS_TIMEOUT_MS;
  // Bound slow/stuck request residency and aggregate connection memory.
  server.requestTimeout = GATEWAY_REQUEST_TIMEOUT_MS;
  server.maxConnections = GATEWAY_MAX_CONNECTIONS;
}
