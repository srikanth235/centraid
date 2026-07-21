import { tempDirSync } from '@centraid/test-kit/temp-dir';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, test } from 'vitest';
import { bootstrapVault } from '../bootstrap.js';
import { openVaultDb, type VaultDb } from '../db.js';
import { uuidv7 } from '../ids.js';
import {
  ReplicaInvocationRepairError,
  readReplicaInvocationCommit,
  recordReplicaInvocationCommitInTransaction,
  repairReplicaInvocationCommits,
  type ReplicaInvocationAudit,
} from './invocation-commits.js';
import {
  deleteReplicaIntentOutcomesForDevice,
  readReplicaIntentOutcome,
  recordReplicaIntentOutcome,
} from './intents.js';

function auditFor(invocationId: string): ReplicaInvocationAudit {
  return {
    commandName: 'test.command',
    agentId: 'device-1',
    agentKind: 'owner',
    grantId: null,
    purpose: 'dpv:ServiceProvision',
    preconditionCount: 0,
    postChecks: [],
    writes: [],
    citations: [],
    provenance: { activity: 'command.test.command', used: { invocation: invocationId } },
    receiptDetail: { writes: [], risk: 'low' },
  };
}

function recordJournalPrefix(db: VaultDb, invocationId: string): void {
  db.journal
    .prepare(
      `INSERT INTO agent_command_invocation (
         invocation_id, command_id, agent_id, grant_id, input_json, status, requested_at
       ) VALUES (?, 'command-1', 'device-1', NULL, '{}', 'checked', ?)`,
    )
    .run(invocationId, '2026-07-15T00:00:00.000Z');
}

function recordCommit(
  db: VaultDb,
  invocationId: string,
  options: { intentId?: string; committedAt?: string } = {},
): void {
  db.vault.exec('BEGIN');
  try {
    recordReplicaInvocationCommitInTransaction(db.vault, {
      invocationId,
      commandId: 'command-1',
      ...(options.intentId ? { intentId: options.intentId } : {}),
      audit: auditFor(invocationId),
      committedAt: options.committedAt ?? '2026-07-15T00:00:00.000Z',
    });
    db.vault.exec('COMMIT');
  } catch (error) {
    db.vault.exec('ROLLBACK');
    throw error;
  }
}

function tempVaultDir(): string {
  return tempDirSync('replica-invocation-repair-');
}

describe('replica invocation commit receipt', () => {
  test('rolls back with the canonical mutation', () => {
    const db = openVaultDb();
    const boot = bootstrapVault(db, { ownerName: 'Owner' });
    const invocationId = uuidv7();
    const calendarId = uuidv7();

    db.vault.exec('BEGIN');
    db.vault
      .prepare(
        `INSERT INTO schedule_calendar (
           calendar_id, owner_party_id, name, default_tz, visibility
         ) VALUES (?, ?, 'Crash boundary', 'UTC', 'private')`,
      )
      .run(calendarId, boot.ownerPartyId);
    recordReplicaInvocationCommitInTransaction(db.vault, {
      invocationId,
      commandId: 'command-1',
      intentId: 'intent-1',
      audit: auditFor(invocationId),
      committedAt: '2026-07-15T00:00:00.000Z',
    });
    db.vault.exec('ROLLBACK');

    expect(readReplicaInvocationCommit(db.vault, invocationId)).toBeUndefined();
    expect(
      db.vault
        .prepare('SELECT 1 AS present FROM schedule_calendar WHERE calendar_id = ?')
        .get(calendarId),
    ).toBeUndefined();
  });

  test('survives a terminal device outcome until journal repair is proven', () => {
    const db = openVaultDb();
    bootstrapVault(db, { ownerName: 'Owner' });
    const invocationId = uuidv7();
    const intentId = 'intent-terminal';
    db.vault.exec('BEGIN');
    recordReplicaInvocationCommitInTransaction(db.vault, {
      invocationId,
      commandId: 'command-1',
      intentId,
      audit: auditFor(invocationId),
      committedAt: '2026-07-15T00:00:00.000Z',
    });
    db.vault.exec('COMMIT');

    recordReplicaIntentOutcome(db.vault, {
      intentId,
      deviceId: 'device-1',
      appId: 'agenda',
      action: 'save',
      payloadHash: 'a'.repeat(64),
      status: 'executed',
      invocationId,
    });

    expect(readReplicaInvocationCommit(db.vault, invocationId)).toBeDefined();
  });

  test('is reclaimed after both journal proof and a terminal device outcome', () => {
    const db = openVaultDb();
    bootstrapVault(db, { ownerName: 'Owner' });
    const invocationId = uuidv7();
    const intentId = 'intent-finalized';
    db.vault.exec('BEGIN');
    recordReplicaInvocationCommitInTransaction(db.vault, {
      invocationId,
      commandId: 'command-1',
      intentId,
      audit: auditFor(invocationId),
      committedAt: '2026-07-15T00:00:00.000Z',
    });
    db.vault
      .prepare(
        `UPDATE replica_invocation_commit SET journal_finalized_at = ? WHERE invocation_id = ?`,
      )
      .run('2026-07-15T00:00:01.000Z', invocationId);
    db.vault.exec('COMMIT');

    recordReplicaIntentOutcome(db.vault, {
      intentId,
      deviceId: 'device-1',
      appId: 'agenda',
      action: 'save',
      payloadHash: 'b'.repeat(64),
      status: 'executed',
      invocationId,
    });

    expect(readReplicaInvocationCommit(db.vault, invocationId)).toBeUndefined();
  });

  test('repairs and reclaims a crash-left ordinary marker on reopen', () => {
    const dir = tempVaultDir();
    let db: VaultDb | undefined;
    try {
      db = openVaultDb({ dir });
      recordJournalPrefix(db, 'invocation-reopen');
      recordCommit(db, 'invocation-reopen');
      db.close();
      db = undefined;

      db = openVaultDb({ dir });
      expect(
        db.journal
          .prepare(
            `SELECT status, receipt_id FROM agent_command_invocation WHERE invocation_id = ?`,
          )
          .get('invocation-reopen'),
      ).toMatchObject({ status: 'executed', receipt_id: expect.any(String) });
      expect(
        db.journal
          .prepare(`SELECT count(*) AS n FROM agent_explanation WHERE invocation_id = ?`)
          .get('invocation-reopen'),
      ).toEqual({ n: 1 });
      expect(readReplicaInvocationCommit(db.vault, 'invocation-reopen')).toBeUndefined();
    } finally {
      db?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('repairs then reclaims a terminal intent marker on reopen', () => {
    const dir = tempVaultDir();
    let db: VaultDb | undefined;
    try {
      db = openVaultDb({ dir });
      recordReplicaIntentOutcome(db.vault, {
        intentId: 'intent-reopen',
        deviceId: 'device-1',
        appId: 'agenda',
        action: 'save',
        payloadHash: 'c'.repeat(64),
        status: 'queued',
      });
      recordJournalPrefix(db, 'invocation-intent-reopen');
      recordCommit(db, 'invocation-intent-reopen', { intentId: 'intent-reopen' });
      recordReplicaIntentOutcome(db.vault, {
        intentId: 'intent-reopen',
        deviceId: 'device-1',
        appId: 'agenda',
        action: 'save',
        payloadHash: 'c'.repeat(64),
        status: 'executed',
        invocationId: 'invocation-intent-reopen',
      });
      expect(readReplicaInvocationCommit(db.vault, 'invocation-intent-reopen')).toBeDefined();
      db.close();
      db = undefined;

      db = openVaultDb({ dir });
      expect(
        db.journal
          .prepare(`SELECT status FROM agent_command_invocation WHERE invocation_id = ?`)
          .get('invocation-intent-reopen'),
      ).toEqual({ status: 'executed' });
      expect(readReplicaInvocationCommit(db.vault, 'invocation-intent-reopen')).toBeUndefined();
      expect(readReplicaIntentOutcome(db.vault, 'intent-reopen', 'device-1')?.status).toBe(
        'executed',
      );
    } finally {
      db?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('revocation retains detached proof until reopen repairs the journal', () => {
    const dir = tempVaultDir();
    let db: VaultDb | undefined;
    try {
      db = openVaultDb({ dir });
      recordReplicaIntentOutcome(db.vault, {
        intentId: 'intent-revoked',
        deviceId: 'device-1',
        appId: 'agenda',
        action: 'save',
        payloadHash: 'd'.repeat(64),
        status: 'parked',
      });
      recordJournalPrefix(db, 'invocation-revoked');
      recordCommit(db, 'invocation-revoked', { intentId: 'intent-revoked' });

      expect(deleteReplicaIntentOutcomesForDevice(db.vault, 'device-1')).toBe(1);
      expect(readReplicaInvocationCommit(db.vault, 'invocation-revoked')).toMatchObject({
        invocationId: 'invocation-revoked',
      });
      expect(readReplicaInvocationCommit(db.vault, 'invocation-revoked')?.intentId).toBeUndefined();
      db.close();
      db = undefined;

      db = openVaultDb({ dir });
      expect(
        db.journal
          .prepare(`SELECT status FROM agent_command_invocation WHERE invocation_id = ?`)
          .get('invocation-revoked'),
      ).toEqual({ status: 'executed' });
      expect(readReplicaInvocationCommit(db.vault, 'invocation-revoked')).toBeUndefined();
    } finally {
      db?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('bounded pages repair later proof while retaining and rejecting an unprovable marker', () => {
    const db = openVaultDb();
    recordCommit(db, 'invocation-missing', { committedAt: '2026-07-15T00:00:00.000Z' });
    recordJournalPrefix(db, 'invocation-provable');
    recordCommit(db, 'invocation-provable', { committedAt: '2026-07-15T00:00:01.000Z' });

    expect(() => repairReplicaInvocationCommits(db, { batchSize: 1 })).toThrow(
      ReplicaInvocationRepairError,
    );
    expect(readReplicaInvocationCommit(db.vault, 'invocation-missing')).toBeDefined();
    expect(readReplicaInvocationCommit(db.vault, 'invocation-provable')).toBeUndefined();
    expect(
      db.journal
        .prepare(`SELECT status FROM agent_command_invocation WHERE invocation_id = ?`)
        .get('invocation-provable'),
    ).toEqual({ status: 'executed' });
    db.close();
  });

  test('reopen fails closed and preserves an unprovable marker', () => {
    const dir = tempVaultDir();
    let db: VaultDb | undefined;
    try {
      db = openVaultDb({ dir });
      recordCommit(db, 'invocation-unprovable');
      db.close();
      db = undefined;

      expect(() => openVaultDb({ dir })).toThrow(ReplicaInvocationRepairError);
      const raw = new DatabaseSync(path.join(dir, 'vault.db'));
      try {
        expect(
          raw
            .prepare(
              `SELECT journal_finalized_at FROM replica_invocation_commit WHERE invocation_id = ?`,
            )
            .get('invocation-unprovable'),
        ).toEqual({ journal_finalized_at: null });
      } finally {
        raw.close();
      }
    } finally {
      db?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
