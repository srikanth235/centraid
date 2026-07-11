// FORMAT.md restore rule 4 ("side-effect quarantine"): a vault dir adopted
// from a backup restore carries `RESTORE_QUARANTINE.json`. Mounting it
// parks the outbox (a plain SQL update, contained) and flags — but does
// NOT auto-resolve — the automations gap (needs the code store + a git
// publish, not a SQL update; see `vault-quarantine.ts`'s header).

import { afterEach, expect, test } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { openVaultPlane, type VaultPlane } from './vault-plane.js';
import { QUARANTINE_MARKER_FILE } from './vault-quarantine.js';

const silentLogger = { info: () => undefined, warn: () => undefined, error: () => undefined };

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `vault-quarantine-${crypto.randomUUID()}-`));
  cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

function openPlane(dir: string): VaultPlane {
  const plane = openVaultPlane({ dir, logger: silentLogger, ownerName: 'Priya' });
  cleanups.push(() => plane.stop());
  return plane;
}

/** Stage one outbox item + a standing grant, both live (not yet approved/drained). */
function seedApprovedOutboxItem(plane: VaultPlane): { itemId: string; grantId: string } {
  const outcome = plane.gateway.invoke(plane.ownerCredential, {
    command: 'sync.configure_credential',
    input: {
      kind: 'pull.gmail',
      label: 'personal',
      cred_kind: 'api_key',
      api_key: 'sk-quarantine-test',
      allowed_hosts: ['gmail.googleapis.com'],
    },
  });
  if (outcome.status !== 'executed')
    throw new Error(`configure failed: ${JSON.stringify(outcome)}`);

  const staged = plane.gateway.invoke(plane.ownerCredential, {
    command: 'outbox.stage',
    input: {
      kind: 'pull.gmail',
      label: 'personal',
      verb: 'gmail.send',
      target: 'ravi@example.com',
      artifact: { to: 'ravi@example.com', subject: 'Hi', body: 'See you.' },
      request: {
        method: 'POST',
        url: 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send',
        headers: { authorization: 'Bearer {{connection:api_key}}' },
        body: '{"raw":"x"}',
      },
    },
  });
  if (staged.status !== 'executed') throw new Error(`stage failed: ${JSON.stringify(staged)}`);
  const itemId = (staged as { output: { item_id: string } }).output.item_id;

  // Simulate an owner approval + a standing grant — both live states the
  // quarantine gesture must neutralize (park the item, revoke the grant).
  const grantId = crypto.randomUUID();
  plane.db.vault
    .prepare(
      `INSERT INTO outbox_grant (grant_id, actor_id, verb, target, created_at, revoked_at)
       VALUES (?, 'owner', 'gmail.send', 'ravi@example.com', ?, NULL)`,
    )
    .run(grantId, new Date().toISOString());
  plane.db.vault
    .prepare(
      `UPDATE outbox_item SET status = 'approved', decided_at = ?, grant_id = ? WHERE item_id = ?`,
    )
    .run(new Date().toISOString(), grantId, itemId);
  return { itemId, grantId };
}

test('no marker — quarantine is a no-op, plane.quarantine stays null', async () => {
  const plane = openPlane(await tempDir());
  expect(plane.quarantine).toBeNull();
});

test('a RESTORE_QUARANTINE.json marker parks the outbox and revokes standing grants on next mount', async () => {
  const dir = await tempDir();
  const first = openPlane(dir);
  const { itemId, grantId } = seedApprovedOutboxItem(first);
  first.stop();

  // Simulate `restoreSnapshot`'s marker having been adopted as a live vault.
  await fs.writeFile(
    path.join(dir, QUARANTINE_MARKER_FILE),
    JSON.stringify({ restoredAt: '2026-01-01T00:00:00.000Z', sourceSeq: 7 }),
  );

  const second = openPlane(dir);
  expect(second.quarantine).toMatchObject({
    sourceSeq: 7,
    restoredAt: '2026-01-01T00:00:00.000Z',
    outboxParked: 1,
    outboxGrantsRevoked: 1,
    automationsNeedManualReview: true,
  });

  const item = second.db.vault
    .prepare('SELECT status, grant_id, decided_at FROM outbox_item WHERE item_id = ?')
    .get(itemId) as { status: string; grant_id: string | null; decided_at: string | null };
  expect(item.status).toBe('pending');
  expect(item.grant_id).toBeNull();
  expect(item.decided_at).toBeNull();

  const grant = second.db.vault
    .prepare('SELECT revoked_at FROM outbox_grant WHERE grant_id = ?')
    .get(grantId) as { revoked_at: string | null };
  expect(grant.revoked_at).not.toBeNull();

  // The marker is deliberately left in place — automations were NOT
  // auto-disabled, so this vault is not fully "resolved" yet.
  expect(await fs.readFile(path.join(dir, QUARANTINE_MARKER_FILE), 'utf8')).toBeTruthy();
});

test('re-mounting an already-parked vault is idempotent (nothing left to park)', async () => {
  const dir = await tempDir();
  const first = openPlane(dir);
  seedApprovedOutboxItem(first);
  first.stop();
  await fs.writeFile(
    path.join(dir, QUARANTINE_MARKER_FILE),
    JSON.stringify({ restoredAt: '2026-01-01T00:00:00.000Z', sourceSeq: 7 }),
  );
  const second = openPlane(dir);
  expect(second.quarantine?.outboxParked).toBe(1);
  second.stop();

  const third = openPlane(dir);
  expect(third.quarantine?.outboxParked).toBe(0); // already pending — nothing to park
  expect(third.quarantine?.outboxGrantsRevoked).toBe(0); // already revoked
});
