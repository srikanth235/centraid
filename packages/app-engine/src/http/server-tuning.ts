import type http from 'node:http';

export const GATEWAY_KEEP_ALIVE_TIMEOUT_MS = 60_000;
export const GATEWAY_HEADERS_TIMEOUT_MS = 65_000;
// Blob ingress is streaming and independently capped at 512 MiB. Keep enough
// wall time for the 512 MiB ceiling over a slow phone uplink (~300 KiB/s)
// while still bounding abandoned request residency.
export const GATEWAY_REQUEST_TIMEOUT_MS = 30 * 60_000;
export const GATEWAY_MAX_CONNECTIONS = 256;
/**
 * How long `close()` lets in-flight requests finish before it destroys the
 * remaining sockets.
 *
 * `http.Server.close()` resolves only once every connection is gone. Node
 * reaps *idle* keep-alive sockets for us, but an **active** request never
 * ends on its own — and this gateway serves several endless `text/event-stream`
 * responses (logs, turn, change feed, run events). One subscribed client is
 * therefore enough to make a bare `server.close()` hang forever, which is
 * exactly what wedged the desktop app's `before-quit` teardown. So: ask
 * politely, then force.
 */
export const GATEWAY_SHUTDOWN_GRACE_MS = 2_000;

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
