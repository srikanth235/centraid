/*
 * Loopback is not an identity — end to end (issue #568 items A and B).
 *
 * `desktop-tunnel.ts` is the SECOND remote→loopback forwarder in the product,
 * live in the shipping desktop through `phone-link.ts`'s `ensurePhoneLink()`.
 * Unlike the gateway's iroh endpoint it has no device key to stamp: it
 * authenticates the phone at the QUIC layer and then speaks to the gateway as
 * the HOST, under the host bearer. Before this issue a QR-paired phone's
 * request therefore arrived header-less on 127.0.0.1 carrying the admin
 * bearer, and the founding gate — which was bare `isLoopbackRequest` on the
 * embedded path — said yes.
 *
 * This drives a real phone client, over a real iroh tunnel, into the real
 * founding route wired with the real `isDirectHostRequest` predicate, and
 * asserts it cannot mint a founding ticket while the host itself still can.
 */

import { tempDir } from '@centraid/test-kit/temp-dir';
import { afterEach, describe, expect, test, vi } from 'vitest';
import crypto from 'node:crypto';
import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import {
  createTunnelClient,
  DEVICE_IDENTITY_HEADER,
  DEVICE_PROOF_HEADER,
  DeviceStore,
  parsePairQrPayload,
  startDesktopTunnel,
  TUNNEL_FORWARDED_HEADER,
  tunnelRequest,
} from '@centraid/tunnel';
import { ROUTES } from '@centraid/protocol';
import { KeyStore } from '@centraid/vault';
import { RecoveryKitStateStore } from '../backup/recovery-kit-state.js';
import { daemonLayoutFor } from '../cli/paths.js';
import { EnrollmentStore } from '../serve/enrollment-store.js';
import { GatewayDatabase } from '../serve/gateway-db.js';
import { PairingTicketStore } from '../serve/pairing-store.js';
import { openVaultRegistry } from '../serve/vault-registry.js';
import { isDirectHostRequest } from './route-helpers.js';
import { makeFoundingRouteHandler } from './founding-routes.js';

vi.setConfig({ testTimeout: 60_000 });

const cleanups: Array<() => Promise<void> | void> = [];
describe('founding-forwarder', () => {
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
  });

  const HOST_BEARER = crypto.randomBytes(16).toString('hex');

  test('a phone on the desktop tunnel cannot mint a founding ticket; the host can', async () => {
    const dataDir = await tempDir('founding-forwarder-');
    cleanups.push(() => fs.rm(dataDir, { recursive: true, force: true }));
    const layout = daemonLayoutFor(dataDir);
    const database = GatewayDatabase.open(dataDir);
    cleanups.push(() => database.close());
    const registry = openVaultRegistry({
      rootDir: layout.vaultDir,
      cacheRootDir: layout.cacheDir,
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    });
    cleanups.push(() => registry.stop());

    const handler = makeFoundingRouteHandler({
      vaults: registry,
      enrollments: EnrollmentStore.open(database),
      tickets: PairingTicketStore.open(database),
      keys: new KeyStore(layout.keysDir),
      recoveryKit: new RecoveryKitStateStore(database),
      // The REAL predicate the daemon and the desktop embed install — not the
      // `() => true` stub the other founding tests use.
      canMintFoundingTicket: isDirectHostRequest,
      endpointTicket: () => 'live-endpoint-ticket',
    });

    // The gateway's loopback listener: bearer-gated exactly as production is.
    const gateway = http.createServer((req, res) => {
      if ((req.headers.authorization ?? '') !== `Bearer ${HOST_BEARER}`) {
        res.statusCode = 401;
        res.end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }
      // Header mirror: proves WHAT reached the gateway, not merely that the
      // gate refused. A test that only asserts 403 would pass even if the
      // forwarder let a client-supplied identity header through.
      if (req.url === '/__headers') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(req.headers));
        return;
      }
      void handler(req, res).then((handled) => {
        if (!handled) {
          res.statusCode = 404;
          res.end();
        }
      });
    });
    cleanups.push(
      () =>
        new Promise<void>((resolve) => {
          gateway.closeAllConnections();
          gateway.close(() => resolve());
        }),
    );
    await new Promise<void>((resolve) => gateway.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${(gateway.address() as AddressInfo).port}`;

    const store = DeviceStore.open(path.join(dataDir, 'phone-devices.json'));
    const desktop = await startDesktopTunnel({
      upstream: () => ({ baseUrl, token: HOST_BEARER }),
      deviceStore: store,
      desktopName: 'Test Desktop',
      relays: 'disabled',
    });
    cleanups.push(() => desktop.close());
    const phone = await createTunnelClient({ relays: 'disabled' });
    cleanups.push(() => phone.close());

    const pairing = desktop.beginPairing();
    const qr = parsePairQrPayload(pairing.qrPayload)!;
    const paired = await phone.pair(qr.ticket, {
      code: qr.code,
      deviceName: 'Owner phone',
      platform: 'ios',
    });
    expect(paired.ok).toBe(true);

    const connection = await phone.connect(desktop.ticket());
    try {
      // A fully paired, fully authorized phone — the tunnel attaches the host
      // bearer for it, so this is NOT an auth failure. It is the founding gate
      // refusing a request a forwarder produced.
      const forwarded = await tunnelRequest(connection, {
        method: 'POST',
        target: ROUTES.gatewayFoundingTicket,
      });
      expect(forwarded.status).toBe(403);
      expect(JSON.parse(Buffer.from(forwarded.body).toString('utf8'))).toMatchObject({
        error: 'possession_required',
      });

      // What actually reached the gateway: the client's copies of the identity
      // headers are gone, and the forwarded marking is stamped. A phone cannot
      // claim an identity, and cannot un-claim being forwarded.
      const mirrored = await tunnelRequest(connection, {
        method: 'GET',
        target: '/__headers',
        headers: {
          [DEVICE_IDENTITY_HEADER]: 'not-my-endpoint',
          [DEVICE_PROOF_HEADER]: 'forged-proof',
          [TUNNEL_FORWARDED_HEADER]: '',
          'x-passthrough': 'kept',
        },
      });
      const seen = JSON.parse(Buffer.from(mirrored.body).toString('utf8')) as Record<
        string,
        string
      >;
      expect(seen[DEVICE_IDENTITY_HEADER]).toBeUndefined();
      expect(seen[DEVICE_PROOF_HEADER]).toBeUndefined();
      expect(seen[TUNNEL_FORWARDED_HEADER]).toBe('1');
      // Ordinary client headers still ride through — this is a targeted strip,
      // not a blanket filter.
      expect(seen['x-passthrough']).toBe('kept');
    } finally {
      connection.close(0n, []);
    }

    // The same route, same bearer, from the host itself: minted.
    const direct = await fetch(`${baseUrl}${ROUTES.gatewayFoundingTicket}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${HOST_BEARER}` },
    });
    expect(direct.status).toBe(200);
    await expect(direct.json()).resolves.toMatchObject({ ok: true, ticket: expect.any(String) });
  });
});
