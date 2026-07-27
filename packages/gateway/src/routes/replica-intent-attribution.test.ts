/*
 * L4 attribution through the replica-intent path (issue #599 decision 8).
 *
 * A write replayed from a phone must name the PERSON who made it, not only
 * the hardware that carried it — and it must name them by id, so a rename on
 * the gateway cannot fork or strand their history. The member travels with
 * the intent (`replica-intent-context.ts`), lands on the invoke request in
 * `VaultPlane.bridgeFor`, and is written into the invocation's journal
 * receipt.
 */

import { tempDir } from '@centraid/test-kit/temp-dir';
import { afterEach, expect, test } from 'vitest';
import { promises as fs } from 'node:fs';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import crypto from 'node:crypto';
import { EnrollmentStore } from '../serve/enrollment-store.js';
import { GatewayDatabase } from '../serve/gateway-db.js';
import { openVaultPlane, type VaultPlane } from '../serve/vault-plane.js';
import { handleReplicaIntent } from './replica-intent-route.js';

const logger = { info: () => undefined, warn: () => undefined, error: () => undefined };
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function plane(): Promise<VaultPlane> {
  const dir = await tempDir(`intent-attribution-${crypto.randomUUID()}-`);
  const opened = openVaultPlane({ bootstrap: true, dir, logger, enableWalShipper: false });
  cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
  cleanups.push(() => opened.stop());
  return opened;
}

function request(body: unknown): IncomingMessage {
  return Object.assign(Readable.from([JSON.stringify(body)]), {
    headers: {},
    method: 'POST',
    url: '/centraid/_vault/replica/intents',
  }) as unknown as IncomingMessage;
}

function response(): ServerResponse {
  return {
    statusCode: 0,
    setHeader: () => undefined,
    end: () => undefined,
  } as unknown as ServerResponse;
}

/** The one receipt the invocation left, decoded. */
function receiptDetail(vault: VaultPlane): Record<string, unknown> {
  const row = vault.db.journal
    .prepare(
      `SELECT detail_json FROM consent_receipt
        WHERE action = 'act schedule.add_task' AND decision = 'allow'
        ORDER BY receipt_id DESC LIMIT 1`,
    )
    .get() as { detail_json: string | null } | undefined;
  expect(row, 'expected an allow receipt for the replayed write').toBeDefined();
  return JSON.parse(row?.detail_json ?? '{}') as Record<string, unknown>;
}

async function replayOfflineWrite(
  vault: VaultPlane,
  access: { deviceId: string; memberId?: string },
): Promise<void> {
  vault.approveGrant('planner', {
    purpose: 'dpv:ServiceProvision',
    scopes: [{ schema: 'schedule', verbs: 'read+act' }],
  });
  const input = { title: 'buy milk' };
  const body = {
    intentId: `intent-${crypto.randomUUID()}`,
    appId: 'planner',
    action: 'add_task',
    input,
    payloadHash: crypto
      .createHash('sha256')
      .update(JSON.stringify({ action: 'add_task', appId: 'planner', input }))
      .digest('hex'),
  };
  await handleReplicaIntent(request(body), response(), {
    plane: vault,
    access: {
      role: 'write',
      rememberDevice: true,
      deviceId: access.deviceId,
      appId: 'planner',
      ...(access.memberId !== undefined ? { memberId: access.memberId } : {}),
    },
    // The real bridge — this is the seam under test, so it is not stubbed.
    dispatch: async () => {
      const result = await vault.bridgeFor('planner')({
        op: 'invoke',
        payload: { command: 'schedule.add_task', input },
      });
      expect(result.ok, JSON.stringify(result)).toBe(true);
      return { status: 'executed' };
    },
  });
}

test('a replayed offline write journals the acting member id', async () => {
  const vault = await plane();

  await replayOfflineWrite(vault, { deviceId: 'sid-phone', memberId: 'member-sid-01' });

  expect(receiptDetail(vault)).toMatchObject({ actingMember: 'member-sid-01' });
  expect(vault.db.vault.prepare('SELECT count(*) AS n FROM schedule_task').get()).toEqual({ n: 1 });
});

test('the attribution is the id, so a rename leaves it exactly as written', async () => {
  const vault = await plane();
  const dir = await tempDir(`intent-attribution-roster-${crypto.randomUUID()}-`);
  cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
  const database = GatewayDatabase.open(dir);
  cleanups.push(() => database.close());
  const enrollments = EnrollmentStore.open(database);
  const sid = enrollments.enroll({
    endpointId: 'sid-phone',
    vaultId: 'vault-family',
    role: 'write',
    label: 'Sid phone',
    memberLabel: 'Sid',
  });

  await replayOfflineWrite(vault, { deviceId: 'sid-phone', memberId: sid.memberId });
  const before = receiptDetail(vault);
  enrollments.members.rename(sid.memberId, 'Siddharth');

  // The journal is append-only and keys on the id — the row is untouched, and
  // it still resolves to the (renamed) person.
  expect(receiptDetail(vault)).toEqual(before);
  expect(before).toMatchObject({ actingMember: sid.memberId });
  expect(enrollments.members.get(sid.memberId)?.label).toBe('Siddharth');
});

test('a write with no resolvable member journals none rather than guessing', async () => {
  const vault = await plane();

  await replayOfflineWrite(vault, { deviceId: 'anonymous-host' });

  expect(receiptDetail(vault)).not.toHaveProperty('actingMember');
});
