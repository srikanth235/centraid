import { promises as fs } from 'node:fs';
import path from 'node:path';

import { forEachSequentially } from '@centraid/test-kit/sequential';
import { tempDir } from '@centraid/test-kit/temp-dir';
import { afterEach, describe, expect, test } from 'vitest';

import { EnrollmentStore } from './enrollment-store.js';
import { GatewayDatabase } from './gateway-db.js';
import { PairingTicketStore } from './pairing-store.js';

const cleanups: Array<() => Promise<void> | void> = [];

async function tempFile(): Promise<string> {
  const dir = await tempDir('device-plane-founding-');
  cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
  return path.join(dir, 'gateway.db');
}

describe('device-plane: founding reservations', () => {
  afterEach(async () => {
    await forEachSequentially(cleanups.splice(0).toReversed(), (cleanup) => cleanup());
  });

  test('a second founding mint cannot destroy an in-flight restore', async () => {
    const gateway = GatewayDatabase.open(path.dirname(await tempFile()));
    cleanups.push(() => gateway.close());
    const tickets = PairingTicketStore.open(gateway);
    const enrollments = EnrollmentStore.open(gateway);
    const founding = tickets.mintFounding()!;
    const reservation = tickets.reserveFounding(founding.ticketId, founding.secret)!;
    expect(tickets.stageReservedFoundingVaults(reservation, ['restored-vault'])).toBe(true);
    expect(tickets.mintFounding()).toBeUndefined();
    expect(tickets.pendingFoundingVaults()).toStrictEqual([
      { reservationId: reservation, vaultIds: ['restored-vault'] },
    ]);
    const enrolled = tickets.redeemReservedFoundingAndEnrollMany(reservation, enrollments, {
      endpointId: 'founder-device',
      vaultIds: ['restored-vault'],
      label: 'Founder laptop',
    });
    expect(enrolled).toHaveLength(1);
    expect(enrollments.list().map((row) => row.vaultId)).toStrictEqual(['restored-vault']);
    expect(tickets.hasOpenFoundingWindow()).toBe(false);
  });

  test('a founding reservation released after a failed attempt frees the slot', async () => {
    const gateway = GatewayDatabase.open(path.dirname(await tempFile()));
    cleanups.push(() => gateway.close());
    const tickets = PairingTicketStore.open(gateway);
    const founding = tickets.mintFounding()!;
    const reservation = tickets.reserveFounding(founding.ticketId, founding.secret)!;
    expect(tickets.mintFounding()).toBeUndefined();
    tickets.releaseFounding(reservation);
    const second = tickets.mintFounding();
    expect(second).toBeTruthy();
    expect(second!.ticketId).not.toBe(founding.ticketId);
  });
});
