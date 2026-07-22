import { handshakeGateway, ROUTES, type HandshakeResult } from '@centraid/protocol';

export interface GatewayClientOptions {
  baseUrl: string;
  token?: string;
  fetchImpl?: typeof fetch;
}

function authHeaders(token: string | undefined): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export async function fetchJson(
  opts: GatewayClientOptions,
  routePath: string,
): Promise<{ status: number; body: unknown }> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const res = await fetchImpl(new URL(routePath, `${opts.baseUrl}/`).toString(), {
    headers: authHeaders(opts.token),
  });
  let body: unknown = null;
  const text = await res.text();
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { status: res.status, body };
}

export function handshake(opts: GatewayClientOptions): Promise<HandshakeResult> {
  return handshakeGateway(opts.baseUrl, opts.token, opts.fetchImpl);
}

export function getInfo(opts: GatewayClientOptions) {
  return fetchJson(opts, ROUTES.gatewayInfo);
}

export function getHealth(opts: GatewayClientOptions) {
  return fetchJson(opts, ROUTES.gatewayHealth);
}

export function listApps(opts: GatewayClientOptions) {
  return fetchJson(opts, ROUTES.appsList);
}
