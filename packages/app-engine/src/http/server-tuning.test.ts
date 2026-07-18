import http from 'node:http';
import { expect, it } from 'vitest';
import {
  GATEWAY_HEADERS_TIMEOUT_MS,
  GATEWAY_KEEP_ALIVE_TIMEOUT_MS,
  GATEWAY_MAX_CONNECTIONS,
  GATEWAY_REQUEST_TIMEOUT_MS,
  tuneGatewayHttpServer,
} from './server-tuning.js';

it('keeps clients warm while bounding slow requests and connection memory (#456 R3)', () => {
  const server = http.createServer();
  tuneGatewayHttpServer(server);
  expect(server.keepAliveTimeout).toBe(GATEWAY_KEEP_ALIVE_TIMEOUT_MS);
  expect(server.headersTimeout).toBe(GATEWAY_HEADERS_TIMEOUT_MS);
  expect(server.requestTimeout).toBe(GATEWAY_REQUEST_TIMEOUT_MS);
  expect(server.maxConnections).toBe(GATEWAY_MAX_CONNECTIONS);
});
