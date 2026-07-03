/*
 * ctx.vault in automation handlers (duaility §12): the fire spine plumbs a
 * host-injected VaultBridge factory (keyed by app id) down to the worker's
 * `ctx.vault` RPC surface. These tests drive a real handler through
 * `runFire` with a STUB bridge, proving:
 *
 *   - vault calls round-trip worker → parent → bridge and back;
 *   - an `invoke` without a caller invocationId gets a DETERMINISTIC one
 *     derived from runId + node ordinal, so re-firing the same runId
 *     replays inside the vault instead of double-executing;
 *   - without a bridge every call fails closed with VAULT_UNAVAILABLE;
 *   - bridge errors surface to the handler with their machine code.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { VaultBridge, VaultCall } from '@centraid/app-engine';
import { runFire, type DispatchSurface } from './fire.js';
import type { Manifest } from '../manifest/manifest.js';

function manifest(over: Partial<Manifest> = {}): Manifest {
  return {
    name: 'VaultFlow',
    version: '0.1.0',
    enabled: true,
    prompt: 'act on the vault',
    triggers: [],
    requires: {},
    history: { keep: { count: 100 } },
    generated: { by: 'test', at: '2026-07-03' },
    ...over,
  };
}

async function writeAutomation(
  appsDir: string,
  appId: string,
  id: string,
  m: Manifest,
  handler: string,
): Promise<void> {
  const dir = path.join(appsDir, appId, 'automations', id);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'automation.json'), JSON.stringify(m, null, 2));
  await fs.writeFile(path.join(dir, 'handler.js'), handler);
}

const stubDispatch = (): Promise<DispatchSurface> =>
  Promise.resolve({
    toolDispatcher: async () => [],
    agentDispatcher: async () => '',
    close: async () => undefined,
  });

describe('runFire + ctx.vault', () => {
  let appsDir: string;

  beforeEach(async () => {
    appsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'centraid-fire-vault-'));
  });
  afterEach(async () => {
    await fs.rm(appsDir, { recursive: true, force: true });
  });

  it('proxies read/invoke through the app-keyed bridge with deterministic invocation ids', async () => {
    await writeAutomation(
      appsDir,
      'notes',
      'filer',
      manifest(),
      `export default async ({ ctx }) => {
         const rows = await ctx.vault.read({ entity: 'schedule.task', purpose: 'dpv:ServiceProvision' });
         const one = await ctx.vault.invoke({ command: 'schedule.add_task', input: { title: 'a' }, purpose: 'dpv:ServiceProvision' });
         const two = await ctx.vault.invoke({ command: 'schedule.add_task', input: { title: 'b' }, purpose: 'dpv:ServiceProvision' });
         return { output: { rows, one, two } };
       };`,
    );

    const calls: VaultCall[] = [];
    const bridgeApps: string[] = [];
    const bridge: VaultBridge = async (call) => {
      calls.push(call);
      if (call.op === 'read') return { ok: true, result: { rows: [], receiptId: 'r1' } };
      return {
        ok: true,
        result: { status: 'executed', invocationId: call.payload.invocationId, output: {} },
      };
    };

    const fire = (dataDir: string): ReturnType<typeof runFire> =>
      runFire(
        {
          automationRef: 'notes/filer',
          runId: 'run-fixed',
          appsDir: dataDir,
          codeAppsDir: appsDir,
          vaultFor: (appId) => {
            bridgeApps.push(appId);
            return bridge;
          },
        },
        { openDispatch: stubDispatch },
      );

    const { outcome } = await fire(appsDir);
    expect(outcome.ok).toBe(true);
    expect(bridgeApps).toEqual(['notes']);
    expect(calls.map((c) => c.op)).toEqual(['read', 'invoke', 'invoke']);
    const ids = calls.filter((c) => c.op === 'invoke').map((c) => c.payload.invocationId);
    expect(ids[0]).toMatch(/^run-fixed:v\d+$/);
    expect(ids[1]).toMatch(/^run-fixed:v\d+$/);
    expect(ids[0]).not.toBe(ids[1]);

    // Re-firing the same runId (fresh ledger, as a crash-replay would see)
    // reproduces the same invocation ids — the vault-side replay key. (The
    // deterministic-handler contract is what the handler lint enforces.)
    const before = ids.slice();
    calls.length = 0;
    const replayDir = await fs.mkdtemp(path.join(os.tmpdir(), 'centraid-fire-vault-replay-'));
    try {
      await fs.mkdir(path.join(replayDir, 'notes'), { recursive: true });
      await fire(replayDir);
    } finally {
      await fs.rm(replayDir, { recursive: true, force: true });
    }
    expect(calls.filter((c) => c.op === 'invoke').map((c) => c.payload.invocationId)).toEqual(
      before,
    );
  });

  it('fails closed with VAULT_UNAVAILABLE when the host injects no bridge', async () => {
    await writeAutomation(
      appsDir,
      'notes',
      'blind',
      manifest(),
      `export default async ({ ctx }) => {
         try {
           await ctx.vault.read({ entity: 'core.party', purpose: 'dpv:ServiceProvision' });
           return { output: { reached: true } };
         } catch (err) {
           return { output: { code: err.code, message: String(err.message) } };
         }
       };`,
    );
    const { outcome } = await runFire(
      { automationRef: 'notes/blind', appsDir },
      { openDispatch: stubDispatch },
    );
    expect(outcome.ok).toBe(true);
    expect(outcome.output).toMatchObject({ code: 'VAULT_UNAVAILABLE' });
  });

  it('surfaces bridge denials to the handler with their machine code', async () => {
    await writeAutomation(
      appsDir,
      'notes',
      'denied',
      manifest(),
      `export default async ({ ctx }) => {
         try {
           await ctx.vault.invoke({ command: 'social.send_message', input: {}, purpose: 'dpv:Billing' });
           return { output: 'unexpected allow' };
         } catch (err) {
           return { output: { code: err.code } };
         }
       };`,
    );
    const deny: VaultBridge = async () => ({
      ok: false,
      code: 'VAULT_CONSENT',
      error: 'deny (receipt r9): no active grant',
    });
    const { outcome } = await runFire(
      { automationRef: 'notes/denied', appsDir, vaultFor: () => deny },
      { openDispatch: stubDispatch },
    );
    expect(outcome.ok).toBe(true);
    expect(outcome.output).toMatchObject({ code: 'VAULT_CONSENT' });
  });
});
