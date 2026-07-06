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

  async function writeConnector(
    handler: string,
    over: Record<string, unknown> = {},
  ): Promise<void> {
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

describe('connector secrets (issue #293)', () => {
  let appsDir: string;
  let transcriptsDbFile: string;

  beforeEach(async () => {
    appsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'centraid-secrets-'));
    transcriptsDbFile = path.join(appsDir, 'transcripts.db');
  });
  afterEach(async () => {
    await fs.rm(appsDir, { recursive: true, force: true });
  });

  async function writeAutomation(
    handler: string,
    over: Record<string, unknown> = {},
  ): Promise<void> {
    const dir = path.join(appsDir, 'mail', 'automations', 'pull');
    await fs.mkdir(dir, { recursive: true });
    const manifest = validateManifest(rawManifest(over)) as Manifest;
    await fs.writeFile(path.join(dir, 'automation.json'), JSON.stringify(manifest, null, 2));
    await fs.writeFile(path.join(dir, 'handler.js'), handler);
  }

  const noDispatch = () =>
    Promise.resolve({
      toolDispatcher: async (batch: readonly { name: string; args: unknown }[]) =>
        batch.map(() => ({ ok: true, result: 'dispatched' })),
      agentDispatcher: async () => 'never',
      close: async () => undefined,
    } satisfies DispatchSurface);

  it('manifest: requires.secrets must be locker refs, and connector-only', () => {
    const m = validateManifest(
      rawManifest({
        requires: { tools: ['gmail.search'], secrets: ['locker:item-1:password'] },
      }),
    );
    expect(m.requires.secrets).toEqual(['locker:item-1:password']);
    expect(() =>
      validateManifest(
        rawManifest({ requires: { tools: ['gmail.search'], secrets: ['not-a-ref'] } }),
      ),
    ).toThrow(/locker:<item_id>:<column>/);
    const nonConnector = rawManifest({
      requires: { secrets: ['locker:item-1:password'] },
    });
    delete nonConnector.connector;
    delete nonConnector.vault;
    expect(() => validateManifest(nonConnector)).toThrow(/connector-only/);
  });

  it('injects the secret at the transport layer and scrubs it from everything recorded', async () => {
    const { createServer } = await import('node:http');
    const seen: string[] = [];
    const server = createServer((req, res) => {
      seen.push(String(req.headers.authorization ?? ''));
      res.writeHead(200, { 'content-type': 'text/plain' });
      // The response ECHOES the secret — the scrub net must catch it.
      res.end(`hello bearer ${req.headers.authorization ?? ''}`);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    try {
      await writeAutomation(
        `export default async ({ ctx, log }) => {
           const res = await ctx.fetch({
             url: 'http://127.0.0.1:${port}/mailbox',
             headers: { authorization: 'Bearer {{secret:locker:item-1:password}}' },
           });
           log.info('fetched ' + res.status);
           return { status: res.status, body: res.text };
         };`,
        { requires: { tools: ['gmail.search'], secrets: ['locker:item-1:password'] } },
      );
      const reveals: string[] = [];
      const bridge: VaultBridge = async (call) => {
        if (call.op === 'reveal') {
          reveals.push(String((call.payload as { entityId: string }).entityId));
          return { ok: true, result: { values: { password: 'imap-app-p4ss' } } };
        }
        if (call.op === 'read') return { ok: true, result: { rows: [{ status: 'active' }] } };
        return { ok: false, code: 'VAULT_ERROR', error: `unexpected op ${call.op}` };
      };
      const { outcome } = await runFire(
        { automationRef: 'mail/pull', appsDir, transcriptsDbFile, vaultFor: () => bridge },
        { openDispatch: noDispatch },
      );
      expect(outcome.ok).toBe(true);
      // The wire carried the REAL secret (transport-level injection)…
      expect(seen).toEqual(['Bearer imap-app-p4ss']);
      expect(reveals).toEqual(['item-1']);
      // …but nothing the run RECORDS holds it: the echoed body is scrubbed.
      expect(JSON.stringify(outcome.value)).not.toContain('imap-app-p4ss');
      expect(JSON.stringify(outcome.value)).toContain('«secret»');
      expect(JSON.stringify(outcome.logs)).not.toContain('imap-app-p4ss');
    } finally {
      server.close();
    }
  });

  it('resolves an aliased secret ref (locker:@alias:column) by alias, not entityId', async () => {
    await writeAutomation(
      `export default async ({ ctx }) => {
         const res = await ctx.fetch({
           url: 'http://127.0.0.1:1/x',
           headers: { authorization: 'Bearer {{secret:locker:@github-token:password}}' },
         }).catch(() => ({ status: 0, text: '' }));
         return { status: res.status };
       };`,
      { requires: { tools: ['gmail.search'], secrets: ['locker:@github-token:password'] } },
    );
    const aliases: Array<string | undefined> = [];
    const bridge: VaultBridge = async (call) => {
      if (call.op === 'reveal') {
        const p = call.payload as { alias?: string; entityId?: string };
        aliases.push(p.alias);
        // The ref carried an alias, never an entityId.
        expect(p.entityId).toBeUndefined();
        return { ok: true, result: { values: { password: 'aliased-secret' } } };
      }
      if (call.op === 'read') return { ok: true, result: { rows: [{ status: 'active' }] } };
      return { ok: false, code: 'VAULT_ERROR', error: `unexpected op ${call.op}` };
    };
    await runFire(
      { automationRef: 'mail/pull', appsDir, transcriptsDbFile, vaultFor: () => bridge },
      { openDispatch: noDispatch },
    );
    expect(aliases).toEqual(['github-token']);
  });

  it('a placeholder outside requires.secrets errors without resolving', async () => {
    await writeAutomation(
      `export default async ({ ctx }) => {
         try {
           await ctx.fetch({ url: 'http://127.0.0.1:1/x', headers: { a: '{{secret:locker:other:password}}' } });
           return { reached: true };
         } catch (err) {
           return { reached: false, reason: err.message };
         }
       };`,
      { requires: { tools: ['gmail.search'], secrets: ['locker:item-1:password'] } },
    );
    const bridge: VaultBridge = async (call) => {
      if (call.op === 'reveal') return { ok: true, result: { values: { password: 'x' } } };
      if (call.op === 'read') return { ok: true, result: { rows: [{ status: 'active' }] } };
      return { ok: false, code: 'VAULT_ERROR', error: 'unexpected' };
    };
    const { outcome } = await runFire(
      { automationRef: 'mail/pull', appsDir, transcriptsDbFile, vaultFor: () => bridge },
      { openDispatch: noDispatch },
    );
    expect(outcome.ok).toBe(true);
    expect(outcome.value).toMatchObject({
      reached: false,
      reason: expect.stringContaining('allowlist'),
    });
  });

  it('ctx.fetch is connector-only', async () => {
    const raw = rawManifest({ requires: {} });
    delete raw.connector;
    delete raw.vault;
    await writeAutomation(
      `export default async ({ ctx }) => {
         try {
           await ctx.fetch({ url: 'http://127.0.0.1:1/x' });
           return { reached: true };
         } catch (err) {
           return { reached: false, reason: err.message };
         }
       };`,
      { requires: {}, connector: undefined, vault: undefined },
    );
    const { outcome } = await runFire(
      { automationRef: 'mail/pull', appsDir, transcriptsDbFile },
      { openDispatch: noDispatch },
    );
    expect(outcome.ok).toBe(true);
    expect(outcome.value).toMatchObject({
      reached: false,
      reason: expect.stringContaining('connector-only'),
    });
  });

  it('a missing secret item flips the connection to needs-auth and skips the run', async () => {
    await writeAutomation(`export default async () => ({ ranAnyway: true });`, {
      requires: { tools: ['gmail.search'], secrets: ['locker:item-gone:password'] },
    });
    const invoked: { command: string; input: Record<string, unknown> }[] = [];
    const bridge: VaultBridge = async (call) => {
      if (call.op === 'read') {
        return {
          ok: true,
          result: { rows: [{ status: 'active', connection_id: 'conn-1' }] },
        };
      }
      if (call.op === 'reveal') {
        return { ok: false, code: 'VAULT_CONSENT', error: 'deny (receipt r9): no revealable row' };
      }
      if (call.op === 'invoke') {
        const payload = call.payload as { command: string; input: Record<string, unknown> };
        invoked.push({ command: payload.command, input: payload.input });
        return { ok: true, result: { status: 'executed' } };
      }
      return { ok: false, code: 'VAULT_ERROR', error: 'unexpected' };
    };
    const { outcome } = await runFire(
      { automationRef: 'mail/pull', appsDir, transcriptsDbFile, vaultFor: () => bridge },
      { openDispatch: noDispatch },
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toMatch(/needs-auth/);
    expect(outcome.value).toBeUndefined(); // the handler never executed
    expect(invoked).toEqual([
      {
        command: 'sync.set_connection_status',
        input: { connection_id: 'conn-1', status: 'needs-auth' },
      },
    ]);
  });
});
