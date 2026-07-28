/*
 * Desktop iroh dialer (issue #555).
 *
 * Gateway identity is the stable EndpointId. Relay URLs are refreshable cache
 * and are converted to a fresh EndpointTicket only at dial time. The device
 * secret is safeStorage-backed and keyed by that gateway EndpointId; corrupt
 * device keys explicitly remint with a warning because re-pairing is the
 * bounded recovery for one client.
 */

import {
  createTunnelClient,
  endpointTicketFor,
  loadEndpointSecret,
  startLocalProxy,
  type LocalProxyHandle,
  type TunnelClient,
} from "@centraid/tunnel";

import { deviceIrohKeyPersistence } from "./gateway-secrets.js";

interface IrohConnection {
  client: TunnelClient;
  proxy: LocalProxyHandle;
  baseUrl: string;
}

const connections = new Map<string, IrohConnection>();
const starting = new Map<string, Promise<IrohConnection>>();
let testProxyResolver:
  | ((
      connectionId: string,
      endpointId: string,
      relayHint?: string
    ) => Promise<string>)
  | undefined;

/**
 * E2E transport seam. The Electron test entry installs this before importing
 * main.js so a loopback mock can stand in for iroh without persisting a URL
 * or token in the production connection registry. It is loaded dynamically
 * by tests/e2e/electron-entry.mjs.
 * @public
 */
export function setIrohProxyResolverForTests(
  resolver: (
    connectionId: string,
    endpointId: string,
    relayHint?: string
  ) => Promise<string>
): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error(
      "the iroh proxy test resolver is available only with NODE_ENV=test"
    );
  }
  testProxyResolver = resolver;
}

export function ensureIrohDeviceKey(connectionId: string): Uint8Array {
  return loadEndpointSecret({
    persistence: deviceIrohKeyPersistence(connectionId),
    onCorrupt: "remint",
    label: `device iroh key for ${connectionId}`,
    warn: (message) => console.warn(`iroh dialer: ${message}`),
  });
}

export async function ensureIrohProxy(
  connectionId: string,
  endpointId: string,
  relayHint?: string
): Promise<string> {
  if (testProxyResolver)
    return testProxyResolver(connectionId, endpointId, relayHint);
  const ready = connections.get(connectionId);
  if (ready) return ready.baseUrl;
  const inFlight = starting.get(connectionId);
  if (inFlight) return (await inFlight).baseUrl;
  const p = (async (): Promise<IrohConnection> => {
    const client = await createTunnelClient({
      secretKey: ensureIrohDeviceKey(connectionId),
    });
    const proxy = await startLocalProxy(() =>
      client.connect(endpointTicketFor(endpointId, relayHint))
    );
    const conn: IrohConnection = {
      client,
      proxy,
      baseUrl: `http://127.0.0.1:${proxy.port}`,
    };
    connections.set(connectionId, conn);
    return conn;
  })().finally(() => starting.delete(connectionId));
  starting.set(connectionId, p);
  return (await p).baseUrl;
}

export async function closeIrohDialer(connectionId: string): Promise<void> {
  const conn = connections.get(connectionId);
  if (!conn) return;
  connections.delete(connectionId);
  await conn.proxy.close().catch(() => undefined);
  await conn.client.close().catch(() => undefined);
}

export async function closeAllIrohDialersExcept(
  exceptId?: string
): Promise<void> {
  await Promise.all(
    [...connections.keys()]
      .filter((connectionId) => connectionId !== exceptId)
      .map((connectionId) => closeIrohDialer(connectionId))
  );
}
