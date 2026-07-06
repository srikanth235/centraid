/*
 * Connector broker invariants (issue #290 phase 4): manifest contract
 * (connector needs a resolved requires.tools allowlist + a vault block),
 * requires-as-allowlist at the tool chokepoint, ctx.agent forbidden in
 * connector handlers, and the honest-liveness fire gate (paused/needs-auth
 * connections never run their connector).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { VaultBridge } from '@centraid/app-engine';
import { runFire, type DispatchSurface, type OpenDispatchArgs } from './fire.js';
import { validateManifest, type Manifest } from '../manifest/manifest.js';

const VAULT_BLOCK = {
  purpose: 'dpv:ServiceProvision',
  why: 'stage pulled rows',
  scopes: [{ schema: 'sync', verbs: 'act' }],
};

function rawManifest(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'Gmail pull',
    version: '0.1.0',
    enabled: true,
    prompt: 'sync mail',
    triggers: [{ kind: 'cron', expr: '*/30 * * * *' }],
    requires: { tools: ['gmail.search', 'gmail.get_message'] },
    connector: { kind: 'mcp.gmail', label: 'personal', principal: 'me@example.com' },
    vault: VAULT_BLOCK,
    history: { keep: { count: 100 } },
    generated: { by: 'test', at: '2026-07-06' },
    ...over,
  };
}

describe('connector manifest contract', () => {
  it('accepts a well-formed connector block', () => {
    const m = validateManifest(rawManifest());
    expect(m.connector).toEqual({
      kind: 'mcp.gmail',
      label: 'personal',
      principal: 'me@example.com',
    });
  });

  it('refuses a connector with no requires.tools allowlist (resolved, not hinted)', () => {
    expect(() => validateManifest(rawManifest({ requires: {} }))).toThrow(/requires\.tools/);
  });

  it('refuses a connector without a vault block', () => {
    const raw = rawManifest();
    delete raw.vault;
    expect(() => validateManifest(raw)).toThrow(/manifest\.vault/);
  });
});

describe('connector runtime gates', () => {
  let appsDir: string;
  let transcriptsDbFile: string;

  beforeEach(async () => {
    appsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'centraid-connector-'));
    transcriptsDbFile = path.join(appsDir, 'transcripts.db');
  });
  afterEach(async () => {
    await fs.rm(appsDir, { recursive: true, force: true });
  });

  async function writeConnector(handler: string, over: Record<string, unknown> = {}): Promise<void> {
    const dir = path.join(appsDir, 'mail', 'automations', 'pull');
    await fs.mkdir(dir, { recursive: true });
    const manifest = validateManifest(rawManifest(over)) as Manifest;
    await fs.writeFile(path.join(dir, 'automation.json'), JSON.stringify(manifest, null, 2));
    await fs.writeFile(path.join(dir, 'handler.js'), handler);
  }

  const openDispatch = (calls: { name: string }[]) => (_args: OpenDispatchArgs) =>
    Promise.resolve({
      toolDispatcher: async (batch: readonly { name: string; args: unknown }[]) => {
        calls.push(...batch.map((c) => ({ name: c.name })));
        return batch.map(() => ({ ok: true, result: 'dispatched' }));
      },
      agentDispatcher: async () => 'should never run',
      close: async () => undefined,
    } satisfies DispatchSurface);

  it('blocks tools outside requires.tools; allowed calls in the same batch still run', async () => {
    await writeConnector(
      `export default async ({ ctx }) => {
         const [ok, blocked] = await Promise.allSettled([
           ctx.tool('gmail.search', { q: 'newer_than:1d' }),
           ctx.tool('gmail.send_message', { to: 'x' }),
         ]);
         return { ok: ok.status, blocked: blocked.status, reason: blocked.reason?.message };
       };`,
    );
    const dispatched: { name: string }[] = [];
    const { outcome } = await runFire(
      { automationRef: 'mail/pull', appsDir, transcriptsDbFile },
      { openDispatch: openDispatch(dispatched) },
    );
    expect(outcome.ok).toBe(true);
    expect(outcome.value).toMatchObject({
      ok: 'fulfilled',
      blocked: 'rejected',
      reason: expect.stringContaining('allowlist'),
    });
    // The disallowed call never reached the dispatcher.
    expect(dispatched.map((c) => c.name)).toEqual(['gmail.search']);
  });

  it('forbids ctx.agent in connector handlers', async () => {
    await writeConnector(
      `export default async ({ ctx }) => {
         try {
           await ctx.agent({ prompt: 'summarize my mail' });
           return { reached: true };
         } catch (err) {
           return { reached: false, reason: err.message };
         }
       };`,
    );
    const { outcome } = await runFire(
      { automationRef: 'mail/pull', appsDir, transcriptsDbFile },
      { openDispatch: openDispatch([]) },
    );
    expect(outcome.ok).toBe(true);
    expect(outcome.value).toMatchObject({
      reached: false,
      reason: expect.stringContaining('forbidden in connector handlers'),
    });
  });

  it('a paused connection never fires its connector (honest liveness)', async () => {
    await writeConnector(`export default async () => ({ ranAnyway: true });`);
    const paused: VaultBridge = async (call) => {
      if (call.op === 'read') {
        return { ok: true, result: { rows: [{ status: 'paused' }] } };
      }
      return { ok: false, code: 'VAULT_ERROR', error: 'unexpected op' };
    };
    const { outcome, record } = await runFire(
      { automationRef: 'mail/pull', appsDir, transcriptsDbFile, vaultFor: () => paused },
      { openDispatch: openDispatch([]) },
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toMatch(/paused/);
    expect(record.ok).toBe(false);
    expect(outcome.value).toBeUndefined(); // the handler never executed
  });

  it('an unreadable status fails open — begin_run stays the hard gate', async () => {
    await writeConnector(`export default async () => ({ ran: true });`);
    const deny: VaultBridge = async () => ({
      ok: false,
      code: 'VAULT_CONSENT',
      error: 'deny (receipt r1): no active grant',
    });
    const { outcome } = await runFire(
      { automationRef: 'mail/pull', appsDir, transcriptsDbFile, vaultFor: () => deny },
      { openDispatch: openDispatch([]) },
    );
    expect(outcome.ok).toBe(true);
    expect(outcome.value).toMatchObject({ ran: true });
  });
});
