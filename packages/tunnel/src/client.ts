import http from "node:http";
import type { AddressInfo } from "node:net";

import { GW_PAIR_ALPN } from "./gateway-endpoint.js";
import type {
  GatewayPairRequest,
  GatewayPairResponse,
} from "./gateway-endpoint.js";
import type { Connection, Endpoint } from "./iroh.js";
import { iroh } from "./iroh.js";
import type {
  HeaderMap,
  PairRequest,
  PairResponse,
  TunnelRequestHeader,
  TunnelResponseHeader,
} from "./protocol.js";
import {
  alpnBytes,
  encodeHeaderFrame,
  PAIR_ALPN,
  PEER_LINK_ALPN,
  readBody,
  readHeaderFrame,
  sanitizeHeaders,
  TUNNEL_ALPN,
} from "./protocol.js";

export interface EndpointTicketHint {
  endpointId: string;
  relayHint?: string;
}

export function endpointIdForSecret(secret: Uint8Array): string {
  if (secret.byteLength !== 32) {
    throw new Error(
      `iroh endpoint secret must be 32 bytes, got ${secret.byteLength}`
    );
  }
  return iroh.SecretKey.fromBytes(Array.from(secret)).public().toString();
}

export function inspectEndpointTicket(ticket: string): EndpointTicketHint {
  const addr = iroh.EndpointTicket.fromString(ticket).endpointAddr();
  const relayHint = addr.relayUrl();
  return {
    endpointId: addr.id().toString(),
    ...(relayHint ? { relayHint } : {}),
  };
}

export function endpointTicketFor(
  endpointId: string,
  relayHint?: string
): string {
  const id = iroh.EndpointId.fromString(endpointId);
  const addr = new iroh.EndpointAddr(id, relayHint ?? null, null);
  return iroh.EndpointTicket.fromAddr(addr).toString();
}

export interface TunnelClientOptions {
  secretKey?: Uint8Array;
  relays?: "n0" | "disabled";
}

export interface TunnelClient {
  endpointId: string;
  secretKeyBytes: () => Uint8Array;
  pair: (ticket: string, request: PairRequest) => Promise<PairResponse>;
  pairGateway: (
    ticket: string,
    request: GatewayPairRequest
  ) => Promise<GatewayPairResponse>;
  connect: (ticket: string) => Promise<Connection>;
  connectPeer: (ticket: string) => Promise<Connection>;
  close: () => Promise<void>;
}

export async function createTunnelClient(
  options: TunnelClientOptions = {}
): Promise<TunnelClient> {
  const builder = iroh.Endpoint.builder();
  builder.applyN0();
  if (options.relays === "disabled")
    builder.relayMode(iroh.RelayMode.disabled());
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
    pairGateway: async (ticket, request) => {
      const addr = iroh.EndpointTicket.fromString(ticket).endpointAddr();
      const connection = await endpoint.connect(addr, alpnBytes(GW_PAIR_ALPN));
      try {
        const bi = await connection.openBi();
        await bi.send.writeAll(encodeHeaderFrame(request));
        await bi.send.finish();
        return await readHeaderFrame<GatewayPairResponse>(bi.recv);
      } finally {
        connection.close(0n, []);
      }
    },
    connect: async (ticket) => {
      const addr = iroh.EndpointTicket.fromString(ticket).endpointAddr();
      return await endpoint.connect(addr, alpnBytes(TUNNEL_ALPN));
    },
    connectPeer: async (ticket) => {
      const addr = iroh.EndpointTicket.fromString(ticket).endpointAddr();
      return await endpoint.connect(addr, alpnBytes(PEER_LINK_ALPN));
    },
    close: () => endpoint.close(),
  };
}

export interface TunnelResponse {
  status: number;
  headers: HeaderMap;
  body: Buffer;
}

export async function tunnelRequest(
  connection: Connection,
  request: {
    method: string;
    target: string;
    headers?: HeaderMap;
    body?: Buffer;
  }
): Promise<TunnelResponse> {
  const bi = await connection.openBi();
  const header: TunnelRequestHeader = {
    method: request.method,
    target: request.target,
    headers: sanitizeHeaders(request.headers ?? {}),
  };
  await bi.send.writeAll(encodeHeaderFrame(header));
  if (request.body && request.body.length > 0)
    await bi.send.writeAll(Array.from(request.body));
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
  close: () => Promise<void>;
}

export async function startLocalProxy(
  getConnection: () => Promise<Connection>,
  options: { port?: number } = {}
): Promise<LocalProxyHandle> {
  const server = http.createServer((request, response) => {
    void (async () => {
      const connection = await getConnection();
      const bi = await connection.openBi();
      await bi.send.writeAll(
        encodeHeaderFrame({
          method: request.method ?? "GET",
          target: request.url ?? "/",
          headers: sanitizeHeaders(request.headers as HeaderMap),
        } satisfies TunnelRequestHeader)
      );
      for await (const chunk of request) {
        await bi.send.writeAll(Array.from(chunk as Buffer));
      }
      await bi.send.finish();
      const responseHeader = await readHeaderFrame<TunnelResponseHeader>(
        bi.recv
      );
      response.writeHead(responseHeader.status, responseHeader.headers);
      await readBody(bi.recv, (c) => {
        response.write(c);
      });
      response.end();
    })().catch((error: unknown) => {
      if (!response.headersSent)
        response.writeHead(502, { "content-type": "application/json" });
      response.end(
        JSON.stringify({ error: "tunnel_error", message: String(error) })
      );
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(options.port ?? 0, "127.0.0.1", resolve);
  });
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
      }),
  };
}
