/*
 * The on-behalf-of cap (issue #599 decision 7).
 *
 * An agent turn acts FOR a member and is hard-capped at that member's role in
 * the vault: Sid's assistant must fail exactly where Sid would. The member and
 * their role travel on the request scope (`vault-context.ts`), reach the agent
 * credential in `VaultPlane.agentBridgeFor`, and the vault's consent stage
 * enforces the cap and journals both principals.
 */

import { tempDir } from '@centraid/test-kit/temp-dir';
import { afterEach, expect, test } from 'vitest';
import { promises as fs } from 'node:fs';
import crypto from 'node:crypto';
import type { VaultBridge } from '@centraid/app-engine';
import { openVaultPlane, type VaultPlane } from './vault-plane.js';
import { runWithVaultContext } from './vault-context.js';
import type { DeviceRole } from './enrollment-store.js';

const logger = { info: () => undefined, warn: () => undefined, error: () => undefined };
const cleanups: Array<() => Promise<void> | void> = [];
const SID = 'member-sid-01';

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function plane(): Promise<VaultPlane> {
  const dir = await tempDir(`agent-cap-${crypto.randomUUID()}-`);
  const opened = openVaultPlane({ bootstrap: true, dir, logger, enableWalShipper: false });
  cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
  cleanups.push(() => opened.stop());
  opened.approveAgentGrant('digest', {
    purpose: 'dpv:ServiceProvision',
    scopes: [{ schema: 'schedule', verbs: 'read+act' }],
  });
  return opened;
}

/** The automation's `ctx.vault`, built inside the acting member's scope. */
function bridgeAs(vault: VaultPlane, memberRole: DeviceRole | undefined): VaultBridge {
  return runWithVaultContext(
    {
      vaultId: vault.boot.vaultId,
      deviceKey: 'sid-phone',
      memberId: SID,
      ...(memberRole ? { memberRole } : {}),
    },
    () => vault.agentBridgeFor('digest'),
  );
}

function taskCount(vault: VaultPlane): number {
  return (vault.db.vault.prepare('SELECT count(*) AS n FROM schedule_task').get() as { n: number })
    .n;
}

function lastReceipt(vault: VaultPlane): { decision: string; detail: Record<string, unknown> } {
  const row = vault.db.journal
    .prepare(
      `SELECT decision, detail_json FROM consent_receipt
        WHERE action = 'act schedule.add_task' ORDER BY receipt_id DESC LIMIT 1`,
    )
    .get() as { decision: string; detail_json: string | null };
  return { decision: row.decision, detail: JSON.parse(row.detail_json ?? '{}') };
}

const addTask = { op: 'invoke' as const, payload: { command: 'schedule.add_task', input: {} } };

test('an agent for a read-role member is refused the write, and the row names both', async () => {
  const vault = await plane();

  const result = await bridgeAs(
    vault,
    'read',
  )({
    ...addTask,
    payload: { command: 'schedule.add_task', input: { title: 'refused' } },
  });

  expect(result.ok).toBe(true);
  if (result.ok) expect(result.result).toMatchObject({ status: 'denied' });
  expect(taskCount(vault)).toBe(0);
  const receipt = lastReceipt(vault);
  expect(receipt.decision).toBe('deny');
  // "agent, for <member>": the member on the receipt, the agent on provenance
  // and the invocation's caller id.
  expect(receipt.detail).toMatchObject({ actingMember: SID });
  expect(String(receipt.detail.failing)).toContain(SID);
});

test('the same agent for a write-role member executes exactly the same call', async () => {
  const vault = await plane();

  const result = await bridgeAs(
    vault,
    'write',
  )({
    ...addTask,
    payload: { command: 'schedule.add_task', input: { title: 'allowed' } },
  });

  expect(result.ok).toBe(true);
  if (result.ok) expect(result.result).toMatchObject({ status: 'executed' });
  expect(taskCount(vault)).toBe(1);
  const receipt = lastReceipt(vault);
  expect(receipt.decision).toBe('allow');
  expect(receipt.detail).toMatchObject({ actingMember: SID });
});

test('a revoked binding caps the agent to nothing, not to the vault owner', async () => {
  const vault = await plane();

  const result = await bridgeAs(
    vault,
    'revoked',
  )({
    ...addTask,
    payload: { command: 'schedule.add_task', input: { title: 'stolen phone' } },
  });

  expect(result.ok).toBe(true);
  if (result.ok) expect(result.result).toMatchObject({ status: 'denied' });
  expect(taskCount(vault)).toBe(0);
});

test('the cap never touches reads — a viewer still sees through their agent', async () => {
  const vault = await plane();

  const result = await bridgeAs(
    vault,
    'read',
  )({
    op: 'read',
    payload: { entity: 'schedule.task' },
  });

  expect(result.ok).toBe(true);
});

test('an automation with no member behind it is uncapped, exactly as before', async () => {
  const vault = await plane();

  // A scheduler fire enters a vault scope with no request and no member.
  const result = await runWithVaultContext({ vaultId: vault.boot.vaultId }, () =>
    vault.agentBridgeFor('digest'),
  )({ ...addTask, payload: { command: 'schedule.add_task', input: { title: 'nightly digest' } } });

  expect(result.ok).toBe(true);
  if (result.ok) expect(result.result).toMatchObject({ status: 'executed' });
  expect(lastReceipt(vault).detail).not.toHaveProperty('actingMember');
});
