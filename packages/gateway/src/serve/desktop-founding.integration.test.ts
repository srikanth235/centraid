import { promises as fs } from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import { forEachSequentially } from '@centraid/test-kit/sequential';
import { tempDir } from '@centraid/test-kit/temp-dir';
import { aesGcmKeyProtector, KeyStore } from '@centraid/vault';
import { describe, afterEach, expect, test } from 'vitest';

import { buildGateway, type BuiltGateway } from './build-gateway.js';
import { EnrollmentStore } from './enrollment-store.js';
import { GatewayDatabase } from './gateway-db.js';
import { PairingTicketStore } from './pairing-store.js';

const cleanups: Array<() => Promise<void> | void> = [];
describe('desktop-founding suite', () => {
  afterEach(async () => {
    await forEachSequentially(cleanups.splice(0).toReversed(), (cleanup) => cleanup());
  });

  async function mount(
    gateway: BuiltGateway,
  ): Promise<{ url: string; close: () => Promise<void> }> {
    const server = http.createServer((req, res) => {
      void (async () => {
        if (await gateway.foundingHandler(req, res)) return;
        await gateway.composedHandler(req, res);
      })();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('desktop founding server not bound');
    return {
      url: `http://127.0.0.1:${address.port}`,
      close: () =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    };
  }

  async function openDesktopGateway(
    dataDir: string,
    hostEndpointId: string,
    wrappingKey: Buffer,
  ): Promise<BuiltGateway> {
    const database = GatewayDatabase.open(dataDir, { lock: 'exclusive' });
    return buildGateway({
      paths: { vaultDir: path.join(dataDir, 'vault') },
      gatewayDatabase: database,
      keyStore: new KeyStore(path.join(dataDir, 'keys'), {
        protector: aesGcmKeyProtector(wrappingKey),
      }),
      hostDeviceEndpointId: hostEndpointId,
      devicePairing: {
        enrollments: EnrollmentStore.open(database),
        tickets: PairingTicketStore.open(database),
        endpointTicket: () => 'live-desktop-endpoint-ticket',
      },
    });
  }

  test('desktop founds through the shared gate and re-adopts its protected owner on restart', async () => {
    const dataDir = await tempDir('desktop-founding-');
    cleanups.push(() => fs.rm(dataDir, { recursive: true, force: true }));
    const hostEndpointId = 'a'.repeat(64);
    const wrappingKey = Buffer.alloc(32, 0x5a);

    let gateway = await openDesktopGateway(dataDir, hostEndpointId, wrappingKey);
    cleanups.push(async () => gateway.stop().catch(() => undefined));
    let server = await mount(gateway);
    cleanups.push(async () => server.close().catch(() => undefined));

    const minted = (await (
      await fetch(`${server.url}/centraid/_gateway/founding/ticket`, {
        method: 'POST',
      })
    ).json()) as { ticket: string };
    const initializedResponse = await fetch(`${server.url}/centraid/_vault/vaults:initialize`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ticket: minted.ticket,
        name: 'Desktop founded',
        password: 'correct horse battery staple',
        deviceName: 'Desktop host',
        platform: 'desktop',
      }),
    });
    const initialized = (await initializedResponse.json()) as {
      vault: { vaultId: string };
      kit: unknown;
      error?: string;
    };
    expect({
      status: initializedResponse.status,
      error: initialized.error,
    }).toStrictEqual({
      status: 201,
      error: undefined,
    });

    const verify = await fetch(`${server.url}/centraid/_vault/vaults:initialize/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        kit: initialized.kit,
        password: 'correct horse battery staple',
        lossConsent: true,
      }),
    });
    expect(verify.status).toBe(200);

    const devicesBefore = (await (
      await fetch(`${server.url}/centraid/_gateway/devices`)
    ).json()) as {
      devices: Array<{ endpointId: string; vaultId: string; role: string }>;
    };
    expect(devicesBefore.devices).toContainEqual(
      expect.objectContaining({
        endpointId: hostEndpointId,
        vaultId: initialized.vault.vaultId,
        role: 'admin',
      }),
    );
    await server.close();
    await gateway.stop();

    const keyEnvelope = await fs.readFile(
      path.join(dataDir, 'keys', `${initialized.vault.vaultId}.sealkey`),
      'utf8',
    );
    expect(keyEnvelope).toMatch(/^CENTRAID-KEY-V1\n/u);
    expect(keyEnvelope).toContain('"scheme":"aes-256-gcm-v1"');
    await expect(fs.access(path.join(dataDir, 'desktop-loopback-token.bin'))).rejects.toMatchObject(
      {
        code: 'ENOENT',
      },
    );

    gateway = await openDesktopGateway(dataDir, hostEndpointId, wrappingKey);
    server = await mount(gateway);
    const vaults = (await (await fetch(`${server.url}/centraid/_vault/vaults`)).json()) as {
      vaults: Array<{ vaultId: string }>;
    };
    expect(vaults.vaults).toContainEqual(
      expect.objectContaining({ vaultId: initialized.vault.vaultId }),
    );
    const devicesAfter = (await (
      await fetch(`${server.url}/centraid/_gateway/devices`)
    ).json()) as {
      devices: Array<{ endpointId: string; vaultId: string; role: string }>;
    };
    expect(devicesAfter.devices).toContainEqual(
      expect.objectContaining({
        endpointId: hostEndpointId,
        vaultId: initialized.vault.vaultId,
        role: 'admin',
      }),
    );
  });
});
