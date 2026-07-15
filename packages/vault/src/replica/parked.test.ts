import { afterEach, expect, test } from 'vitest';
import { openVaultDb, type VaultDb } from '../db.js';
import {
  deleteDurableParkedPayload,
  deleteDurableParkedPayloadsForGrant,
  listDurableParkedPayloads,
  readDurableParkedPayload,
  saveDurableParkedPayload,
  settleDurableParkedPayload,
} from './parked.js';
import { readReplicaIntentOutcome, recordReplicaIntentOutcome } from './intents.js';

let db: VaultDb | undefined;
afterEach(() => {
  db?.close();
  db = undefined;
});

test('parked command payloads survive gateway recreation encrypted at rest', () => {
  db = openVaultDb();
  saveDurableParkedPayload(db, {
    invocationId: 'inv-1',
    intentId: 'intent-1',
    identity: {
      kind: 'app',
      callerId: 'app-1',
      provAgentKind: 'app',
      partyId: null,
      mayAct: true,
    },
    request: {
      command: 'locker.send_secret',
      input: { password: 'never-plaintext-at-rest' },
      purpose: 'dpv:ServiceProvision',
      invocationId: 'inv-1',
    },
    grantId: 'grant-1',
    commandId: 'command-1',
    commandName: 'locker.send_secret',
    reason: 'owner confirmation required',
    parkedAt: '2026-07-15T00:00:00.000Z',
  });

  const stored = db.vault
    .prepare('SELECT request_sealed FROM replica_parked_payload WHERE invocation_id = ?')
    .get('inv-1') as { request_sealed: string };
  expect(stored.request_sealed).not.toContain('never-plaintext-at-rest');
  expect(readDurableParkedPayload(db, 'inv-1')?.request.input).toEqual({
    password: 'never-plaintext-at-rest',
  });
  expect(listDurableParkedPayloads(db)).toHaveLength(1);
  expect(deleteDurableParkedPayload(db, 'inv-1')).toBe(true);
  expect(readDurableParkedPayload(db, 'inv-1')).toBeUndefined();
});

test('grant revocation drops every durable parked payload on that grant', () => {
  db = openVaultDb();
  const base = {
    identity: {
      kind: 'app' as const,
      callerId: 'app-1',
      provAgentKind: 'app' as const,
      partyId: null,
      mayAct: true,
    },
    request: { command: 'social.send', input: {} },
    grantId: 'grant-1',
    commandId: 'command-1',
    commandName: 'social.send',
    reason: 'confirm',
    parkedAt: '2026-07-15T00:00:00.000Z',
  };
  saveDurableParkedPayload(db, { ...base, invocationId: 'inv-1' });
  saveDurableParkedPayload(db, { ...base, invocationId: 'inv-2' });
  expect(deleteDurableParkedPayloadsForGrant(db, 'grant-1')).toEqual(['inv-1', 'inv-2']);
  expect(listDurableParkedPayloads(db)).toEqual([]);
});

test('settlement rolls payload deletion back when the terminal outcome cannot commit', () => {
  db = openVaultDb();
  recordReplicaIntentOutcome(db.vault, {
    intentId: 'intent-1',
    deviceId: 'device-1',
    appId: 'agenda',
    action: 'save',
    payloadHash: 'a'.repeat(64),
    status: 'parked',
    invocationId: 'inv-1',
  });
  saveDurableParkedPayload(db, {
    invocationId: 'inv-1',
    intentId: 'intent-1',
    identity: {
      kind: 'app',
      callerId: 'app-1',
      provAgentKind: 'app',
      partyId: null,
      mayAct: true,
    },
    request: { command: 'schedule.save', input: {}, invocationId: 'inv-1' },
    grantId: 'grant-1',
    commandId: 'command-1',
    commandName: 'schedule.save',
    reason: 'confirm',
    parkedAt: '2026-07-15T00:00:00.000Z',
  });
  db.vault.exec(`CREATE TEMP TRIGGER reject_terminal_outcome
    BEFORE UPDATE ON replica_intent_outcome BEGIN
      SELECT RAISE(ABORT, 'simulated terminal outcome failure');
    END`);

  expect(() =>
    settleDurableParkedPayload(db as VaultDb, 'inv-1', {
      intentId: 'intent-1',
      outcome: { status: 'executed', invocationId: 'inv-1' },
    }),
  ).toThrow(/simulated terminal outcome failure/);
  expect(readDurableParkedPayload(db, 'inv-1')).toBeDefined();
  expect(readReplicaIntentOutcome(db.vault, 'intent-1', 'device-1')).toMatchObject({
    status: 'parked',
    invocationId: 'inv-1',
  });
});
