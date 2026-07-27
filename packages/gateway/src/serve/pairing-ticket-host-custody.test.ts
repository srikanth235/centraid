/*
 * The CLI minting lane stays open with no paired device, at any tier.
 *
 * `centraid-gateway pair` runs with shell access on the gateway host and no
 * device identity — the devices route authorizes it through its own
 * host-custody check (`canMintPairingTicket` → `isDirectHostRequest`). The
 * composed handler's global "proved enrolled device" gate used to run first,
 * so that hatch was unreachable and a headless daemon could not enroll a
 * second device from the CLI after founding. (Founding itself is unaffected:
 * it runs on `foundingHandler`, mounted outside the composed handler.)
 *
 * The bypass must stay narrow — a loopback, non-forwarded caller only. An
 * iroh-forwarded request carries device headers and must still be gated.
 */

import { tempDir } from '@centraid/test-kit/temp-dir';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { buildGateway, type BuiltGateway } from './build-gateway.ts';
import { EnrollmentStore } from './enrollment-store.ts';
import { GatewayDatabase } from './gateway-db.ts';
import { PairingTicketStore } from './pairing-store.ts';
import { isDirectHostRequest } from '../routes/route-helpers.ts';

const TICKET_PATH = '/centraid/_gateway/devices/ticket';
/** Stands in for the daemon's per-boot device proof. */
const PROOF = 'per-boot-device-proof';

let dataDir: string;
let database: GatewayDatabase;
let gateway: BuiltGateway;
let server: http.Server;
let base: string;

beforeEach(async () => {
  dataDir = await tempDir('pair-host-custody-');
  database = GatewayDatabase.open(dataDir, { lock: 'exclusive' });
  const enrollments = EnrollmentStore.open(database);
  const tickets = PairingTicketStore.open(database);
  gateway = await buildGateway({
    initVaultName: "Owner's vault",
    paths: { dataDir, vaultDir: path.join(dataDir, 'vault') },
    gatewayDatabase: database,
    devicePairing: { enrollments, tickets, endpointTicket: () => 'endpoint-ticket' },
    canMintFoundingTicket: isDirectHostRequest,
    // Mirrors the daemon's resolver rather than letting buildGateway fall back
    // to `embeddedAccess`, which resolves EVERY loopback request to the
    // embedded owner and would make the negative case pass vacuously.
    deviceAccess: {
      deviceKeyFor: (req) => {
        const device = req.headers['x-centraid-device'];
        if (typeof device !== 'string' || device.length === 0) return undefined;
        return req.headers['x-centraid-device-proof'] === PROOF ? device : undefined;
      },
      vaultsFor: (deviceKey) => enrollments.vaultsFor(deviceKey),
    },
  });
  server = http.createServer((req, res) => {
    void gateway.composedHandler(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no bound address');
  base = `http://127.0.0.1:${addr.port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await gateway.stop().catch(() => undefined);
  database.close();
  await fs.rm(dataDir, { recursive: true, force: true });
});

test('direct host custody mints the first ticket with no enrolled device', async () => {
  const minted = await fetch(`${base}${TICKET_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });

  expect(minted.status).toBe(200);
  expect(await minted.json()).toMatchObject({ ok: true, role: 'write' });
});

test('an iroh-forwarded caller never reaches the host-custody hatch', async () => {
  const forwarded = await fetch(`${base}${TICKET_PATH}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-centraid-tunnel-forwarded': '1',
      'x-centraid-device': 'unenrolled-device',
      'x-centraid-device-proof': 'not-the-per-boot-proof',
    },
    body: JSON.stringify({}),
  });

  expect(forwarded.status).toBe(403);
  // Asserting the MESSAGE, not just the shared `device_identity_required`
  // code: the devices route refuses an unproved caller too, with the same
  // code but its own wording. Pinning the gate's wording is what proves the
  // forwarded request was stopped BEFORE the route — drop
  // `isDirectHostRequest` from the bypass and this flips to the route's
  // "pairing tickets require…" text.
  expect(await forwarded.json()).toMatchObject({
    error: 'device_identity_required',
    message: 'this request has no proved enrolled device identity',
  });
});

test('host custody may mint an admin ticket for a second admin device', async () => {
  const minted = await fetch(`${base}${TICKET_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ role: 'admin' }),
  });

  expect(minted.status).toBe(200);
  expect(await minted.json()).toMatchObject({ ok: true, role: 'admin' });
});
