/*
 * Phone side of the tunnel, in TypeScript (issue #263).
 *
 * On a real phone this logic lives in the Expo native module
 * (apps/mobile/modules/centraid-tunnel — Swift + Kotlin); this Node
 * implementation is the executable reference for that protocol and powers
 * the integration tests and the Phase 0 spike CLI. Behavior here and in the
 * native module must stay in lockstep with protocol.ts.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Connection, Endpoint } from './iroh.js';
import { iroh } from './iroh.js';
import type {
  HeaderMap,
  PairRequest,
  PairResponse,
  TunnelRequestHeader,
  TunnelResponseHeader,
} from './protocol.js';
import {
  alpnBytes,
  encodeHeaderFrame,
  PAIR_ALPN,
  readBody,
  readHeaderFrame,
  sanitizeHeaders,
  TUNNEL_ALPN,
} from './protocol.js';

export interface TunnelClientOptions {
  /** 32-byte device secret; omit to generate a fresh device identity. */
  secretKey?: Uint8Array;
  /** `disabled` keeps tests offline; production uses the n0 relays + discovery. */
  relays?: 'n0' | 'disabled';
}

export interface TunnelClient {
  /** This device's transport identity (base32 EndpointId). */
  endpointId: string;
  secretKeyBytes(): Uint8Array;
  /** Pair with a desktop using the QR payload's ticket + one-time code. */
  pair(ticket: string, request: PairRequest): Promise<PairResponse>;
  /** Dial the desktop's tunnel ALPN. */
  connect(ticket: string): Promise<Connection>;
  close(): Promise<void>;
}

export async function createTunnelClient(options: TunnelClientOptions = {}): Promise<TunnelClient> {
  const builder = iroh.Endpoint.builder();
  builder.applyN0();
  if (options.relays === 'disabled') builder.relayMode(iroh.RelayMode.disabled());
  if (options.secretKey) builder.secretKey(Array.from(options.secretKey));
  const endpoint: Endpoint = await builder.bind();

  return {
    endpointId: endpoint.id().toString(),
    secretKeyBytes: () => Uint8Array.from(endpoint.secretKey().toBytes()),
    pair: async (ticket, request) => {
      const addr = iroh.EndpointTicket.fromString(ticket).endpointAddr();
      const connection = await endpoint.connect(addr, alpnBytes(PAIR_ALPN));
      try {
        const bi = await connection.openBi();
        await bi.send.writeAll(encodeHeaderFrame(request));
        await bi.send.finish();
        return await readHeaderFrame<PairResponse>(bi.recv);
      } finally {
        connection.close(0n, []);
      }
    },
    connect: async (ticket) => {
      const addr = iroh.EndpointTicket.fromString(ticket).endpointAddr();
      return await endpoint.connect(addr, alpnBytes(TUNNEL_ALPN));
    },
    close: () => endpoint.close(),
  };
}

export interface TunnelResponse {
  status: number;
  headers: HeaderMap;
  body: Buffer;
}

/** One HTTP request over one bi-stream, response buffered (test helper). */
export async function tunnelRequest(
  connection: Connection,
  request: { method: string; target: string; headers?: HeaderMap; body?: Buffer },
): Promise<TunnelResponse> {
  const bi = await connection.openBi();
  const header: TunnelRequestHeader = {
    method: request.method,
    target: request.target,
    headers: sanitizeHeaders(request.headers ?? {}),
  };
  await bi.send.writeAll(encodeHeaderFrame(header));
  if (request.body && request.body.length > 0) await bi.send.writeAll(Array.from(request.body));
  await bi.send.finish();
  const responseHeader = await readHeaderFrame<TunnelResponseHeader>(bi.recv);
  const chunks: Buffer[] = [];
  await readBody(bi.recv, (c) => void chunks.push(c));
  return {
    status: responseHeader.status,
    headers: responseHeader.headers,
    body: Buffer.concat(chunks),
  };
}

export interface LocalProxyHandle {
  port: number;
  close(): Promise<void>;
}

/**
 * Localhost HTTP proxy: the WebView points at `http://127.0.0.1:<port>` and
 * every request — documents, module imports, EventSource — is forwarded
 * through the tunnel connection. Responses stream chunk-by-chunk, so SSE
 * events arrive live.
 */
export async function startLocalProxy(
  getConnection: () => Promise<Connection>,
  options: { port?: number } = {},
): Promise<LocalProxyHandle> {
  const server = http.createServer((request, response) => {
    void (async () => {
      const connection = await getConnection();
      const bi = await connection.openBi();
      await bi.send.writeAll(
        encodeHeaderFrame({
          method: request.method ?? 'GET',
          target: request.url ?? '/',
          headers: sanitizeHeaders(request.headers as HeaderMap),
        } satisfies TunnelRequestHeader),
      );
      for await (const chunk of request) {
        await bi.send.writeAll(Array.from(chunk as Buffer));
      }
      await bi.send.finish();
      const responseHeader = await readHeaderFrame<TunnelResponseHeader>(bi.recv);
      response.writeHead(responseHeader.status, responseHeader.headers);
      await readBody(bi.recv, (c) => {
        response.write(c);
      });
      response.end();
    })().catch((err: unknown) => {
      if (!response.headersSent) response.writeHead(502, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'tunnel_error', message: String(err) }));
    });
  });
  await new Promise<void>((resolve) => server.listen(options.port ?? 0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
