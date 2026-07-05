/*
 * Desktop dialer for remote iroh gateways (issue #289 phase 3).
 *
 * A `direct` remote profile is a URL the HTTP client hits straight. An
 * `iroh` profile has no URL — only the gateway's EndpointId + relay hint.
 * This module dissolves that difference for the rest of the app: it dials
 * the gateway over the same `centraid/tunnel/1` protocol the phone speaks
 * and stands up a loopback HTTP proxy (`startLocalProxy`), so
 * `resolveGateway` can hand back a plain `http://127.0.0.1:<port>` base URL
 * that `gateway-client-core` and the auth-injector use unchanged. The
 * device's iroh secret key is persisted per profile, so its EndpointId is
 * stable across launches (it must match what the gateway enrolled).
 *
 * The QUIC dial is inherently a live-network operation; this module owns the
 * lifecycle (one proxy per profile, dedupe, teardown) and delegates the
 * wire to `@centraid/tunnel`, which is covered by its own offline battery.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  createTunnelClient,
  startLocalProxy,
  type LocalProxyHandle,
  type TunnelClient,
} from '@centraid/tunnel';
import { gatewayDir } from './gateway-paths.js';

interface IrohConnection {
  client: TunnelClient;
  proxy: LocalProxyHandle;
  /** `http://127.0.0.1:<port>` the HTTP client targets. */
  baseUrl: string;
}

const connections = new Map<string, IrohConnection>();
const starting = new Map<string, Promise<IrohConnection>>();

/** Where a profile's stable iroh device key lives (mirrors phone-link/key.bin). */
function deviceKeyFile(gatewayId: string): string {
  return path.join(gatewayDir(gatewayId), 'iroh-device-key.bin');
}

function readOrMintDeviceKey(gatewayId: string): Uint8Array {
  const file = deviceKeyFile(gatewayId);
  try {
    const bytes = fs.readFileSync(file);
    if (bytes.length === 32) return Uint8Array.from(bytes);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  const key = crypto.randomBytes(32);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, key, { mode: 0o600 });
  return Uint8Array.from(key);
}

/**
 * The EndpointId this device presents to a gateway (its enrollment key).
 * Shown in Settings so the admin can `centraid-gateway devices add` it, and
 * used by the pairing flow. Mints the stable key on first read.
 */
export async function deviceEndpointId(gatewayId: string): Promise<string> {
  const existing = connections.get(gatewayId);
  if (existing) return existing.client.endpointId;
  const client = await createTunnelClient({ secretKey: readOrMintDeviceKey(gatewayId) });
  const id = client.endpointId;
  await client.close();
  return id;
}

/**
 * Ensure a loopback proxy to the iroh gateway named by `endpointTicket`
 * (the EndpointTicket string — EndpointId + relay hint) is up, and return
 * its base URL. Deduped per gateway id; the connection is torn down by
 * `closeIrohDialer` on gateway switch.
 */
export async function ensureIrohProxy(gatewayId: string, endpointTicket: string): Promise<string> {
  const ready = connections.get(gatewayId);
  if (ready) return ready.baseUrl;
  const inFlight = starting.get(gatewayId);
  if (inFlight) return (await inFlight).baseUrl;
  const p = (async (): Promise<IrohConnection> => {
    const client = await createTunnelClient({ secretKey: readOrMintDeviceKey(gatewayId) });
    // Re-dial per proxy request so the tunnel follows a dropped connection;
    // startLocalProxy calls this for every HTTP request.
    const proxy = await startLocalProxy(() => client.connect(endpointTicket));
    const conn: IrohConnection = {
      client,
      proxy,
      baseUrl: `http://127.0.0.1:${proxy.port}`,
    };
    connections.set(gatewayId, conn);
    return conn;
  })().finally(() => {
    starting.delete(gatewayId);
  });
  starting.set(gatewayId, p);
  return (await p).baseUrl;
}

/** Tear down a profile's proxy + tunnel client. Idempotent. */
export async function closeIrohDialer(gatewayId: string): Promise<void> {
  const conn = connections.get(gatewayId);
  if (!conn) return;
  connections.delete(gatewayId);
  await conn.proxy.close().catch(() => undefined);
  await conn.client.close().catch(() => undefined);
}

/** Tear down every proxy except `exceptId` — the gateway-switch teardown. */
export async function closeAllIrohDialersExcept(exceptId?: string): Promise<void> {
  const ids = [...connections.keys()].filter((id) => id !== exceptId);
  await Promise.all(ids.map((id) => closeIrohDialer(id)));
}
