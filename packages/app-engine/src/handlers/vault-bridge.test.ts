import { tempDir } from '@centraid/test-kit/temp-dir';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Registry } from '../registry/registry.js';
import { Dispatcher } from './dispatcher.js';
import { parseManifest, ManifestError } from '../registry/manifest.js';
import { buildExtraPrompt } from './build-extra-prompt.js';
import type { VaultCall, VaultCallResult } from './vault-bridge.js';

const writeJson = (file: string, data: unknown) =>
  fs.writeFile(file, JSON.stringify(data, null, 2), 'utf8');

/** An app whose handlers exercise ctx.vault — the second RPC channel. */
async function makeVaultApp(codeRoot: string, appId: string): Promise<void> {
  const dir = path.join(codeRoot, appId);
  await fs.mkdir(path.join(dir, 'actions'), { recursive: true });
  await fs.mkdir(path.join(dir, 'queries'), { recursive: true });
  await writeJson(path.join(dir, 'app.json'), {
    manifestVersion: 1,
    id: appId,
    name: 'Planner',
    version: '0.1.0',
    actions: [
      {
        name: 'propose',
        confirmation: 'none',
        input: { type: 'object', properties: { summary: { type: 'string' } } },
      },
    ],
    queries: [{ name: 'agenda', input: { type: 'object' } }],
    vault: {
      purpose: 'dpv:ServiceProvision',
      why: 'Reads the calendar to plan the day.',
      scopes: [{ schema: 'schedule', verbs: 'read+act' }],
    },
  });
  await fs.writeFile(
    path.join(dir, 'actions', 'propose.js'),
    `export default async ({ body, ctx }) => {
       const invoke = (ordinal) => ctx.vault.invoke({
         command: 'schedule.propose_event',
         input: { summary: body?.summary },
         purpose: 'dpv:ServiceProvision',
         invocationId: 'handler-selected-' + ordinal,
       });
       const outcome = await invoke('first');
       if (body?.summary === 'Twice') await invoke('second');
       return { status: 200, body: outcome };
     };\n`,
    'utf8',
  );
  await fs.writeFile(
    path.join(dir, 'queries', 'agenda.js'),
    `export default async ({ ctx }) => {
       try {
         return await ctx.vault.read({ entity: 'core.event', purpose: 'dpv:ServiceProvision' });
       } catch (err) {
         return { deniedCode: err.code, message: err.message };
       }
     };\n`,
    'utf8',
  );
}

describe('ctx.vault worker channel', () => {
  let workDir: string;
  let codeRoot: string;
  let registry: Registry;

  beforeAll(async () => {
    workDir = await tempDir('centraid-vault-bridge-');
    codeRoot = await tempDir('centraid-vault-bridge-code-');
    await makeVaultApp(codeRoot, 'planner');
    registry = new Registry(workDir);
    await registry.load();
    await registry.ensureUploaded('planner');
  });

  afterAll(async () => {
    await fs.rm(workDir, { recursive: true, force: true });
    await fs.rm(codeRoot, { recursive: true, force: true });
  });

  it('round-trips a ctx.vault.invoke through the injected bridge', async () => {
    const calls: Array<{ appId: string; call: VaultCall }> = [];
    const dispatcher = new Dispatcher({
      registry,
      codeDirOverride: async (appId) => path.join(codeRoot, appId),
      vaultFor:
        (appId) =>
        async (call): Promise<VaultCallResult> => {
          calls.push({ appId, call });
          return { ok: true, result: { status: 'executed', output: { event_id: 'ev1' } } };
        },
    });
    const out = await dispatcher.write({
      app: 'planner',
      action: 'propose',
      input: { summary: 'Standup' },
    });
    expect(out.isError).toBe(false);
    expect(out.structuredContent).toMatchObject({
      status: 'executed',
      output: { event_id: 'ev1' },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      appId: 'planner',
      call: {
        op: 'invoke',
        payload: { command: 'schedule.propose_event', input: { summary: 'Standup' } },
      },
    });
  });

  it('binds an offline action intent to a deterministic vault invocation id', async () => {
    const calls: VaultCall[] = [];
    const dispatcher = new Dispatcher({
      registry,
      codeDirOverride: async (appId) => path.join(codeRoot, appId),
      vaultFor: () => async (call) => {
        calls.push(call);
        return { ok: true, result: { status: 'executed', output: { event_id: 'ev1' } } };
      },
    });
    await dispatcher.write({
      app: 'planner',
      action: 'propose',
      input: { summary: 'Offline standup' },
      intentId: 'intent-offline-1',
    });
    await dispatcher.write({
      app: 'planner',
      action: 'propose',
      input: { summary: 'Offline standup retry' },
      intentId: 'intent-offline-1',
    });
    await dispatcher.write({
      app: 'planner',
      action: 'propose',
      input: { summary: 'Collision probe' },
      intentId: 'intent-offline-1:1',
    });
    await dispatcher.write({
      app: 'planner',
      action: 'propose',
      input: { summary: 'Twice' },
      intentId: 'intent-multi',
    });
    await dispatcher.write({
      app: 'planner',
      action: 'propose',
      input: { summary: 'Twice' },
      intentId: 'intent-multi',
    });

    const invocationIds = calls.map((call) => String(call.payload.invocationId));
    expect(invocationIds[0]).toMatch(/^replica:v1:[a-f0-9]{64}$/);
    expect(invocationIds[0]).not.toBe('handler-selected-first');
    expect(invocationIds[1]).toBe(invocationIds[0]);
    expect(invocationIds[2]).not.toBe(invocationIds[0]);
    expect(invocationIds.slice(3, 5)).toEqual(invocationIds.slice(5, 7));
    expect(invocationIds[3]).not.toBe(invocationIds[4]);
    expect(invocationIds.slice(3, 5)).not.toContain('handler-selected-first');
    expect(invocationIds.slice(3, 5)).not.toContain('handler-selected-second');
    expect(calls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          op: 'invoke',
          payload: expect.objectContaining({ intentId: 'intent-offline-1' }),
        }),
      ]),
    );
  });

  it('a bridge refusal rejects in the handler with code + receipted message', async () => {
    const dispatcher = new Dispatcher({
      registry,
      codeDirOverride: async (appId) => path.join(codeRoot, appId),
      vaultFor: () => async () => ({
        ok: false,
        code: 'VAULT_CONSENT',
        error: 'deny (receipt r123): no active grant covers schedule read',
      }),
    });
    const out = await dispatcher.read({ app: 'planner', query: 'agenda', input: {} });
    expect(out.isError).toBe(false);
    expect(out.structuredContent).toMatchObject({ deniedCode: 'VAULT_CONSENT' });
    expect((out.structuredContent as { message: string }).message).toContain('receipt r123');
  });

  it('fails closed with VAULT_UNAVAILABLE when no bridge is mounted', async () => {
    const dispatcher = new Dispatcher({
      registry,
      codeDirOverride: async (appId) => path.join(codeRoot, appId),
    });
    const out = await dispatcher.read({ app: 'planner', query: 'agenda', input: {} });
    expect(out.isError).toBe(false);
    expect(out.structuredContent).toMatchObject({ deniedCode: 'VAULT_UNAVAILABLE' });
  });
});

describe('manifest vault block', () => {
  const base = {
    manifestVersion: 1,
    id: 'a',
    name: 'A',
    version: '1',
    actions: [],
    queries: [],
  };

  it('parses and passes through a declared vault block', () => {
    const manifest = parseManifest(
      JSON.stringify({
        ...base,
        vault: { purpose: 'dpv:ServiceProvision', scopes: [{ schema: 'schedule', verbs: 'read' }] },
      }),
    );
    expect(manifest.vault).toEqual({
      purpose: 'dpv:ServiceProvision',
      scopes: [{ schema: 'schedule', verbs: 'read' }],
    });
  });

  it('rejects a vault block with bad verbs or no scopes', () => {
    expect(() =>
      parseManifest(
        JSON.stringify({
          ...base,
          vault: { purpose: 'p', scopes: [{ schema: 'schedule', verbs: 'write' }] },
        }),
      ),
    ).toThrow(ManifestError);
    expect(() =>
      parseManifest(JSON.stringify({ ...base, vault: { purpose: 'p', scopes: [] } })),
    ).toThrow(ManifestError);
  });

  it('build prompt scopes the vault-primitive teaching to declared access; the external-world contract is always taught', () => {
    const without = buildExtraPrompt({
      appId: 'a',
      manifest: parseManifest(JSON.stringify(base)),
    });
    // No declared access → no per-app vault block (scopes, read/search)…
    expect(without).not.toContain('### Personal vault');
    expect(without).not.toContain('ctx.vault.read');
    // …but the external-world doctrine (issue #308 B1) renders regardless:
    // "build me something that emails" needs the outbox before scopes exist.
    expect(without).toContain('outbox.stage');
    expect(without).toContain('READ-ONLY');
    expect(without).toContain('{{connection:');
    const withVault = buildExtraPrompt({
      appId: 'a',
      manifest: parseManifest(
        JSON.stringify({
          ...base,
          vault: {
            purpose: 'dpv:ServiceProvision',
            why: 'plans the day',
            scopes: [{ schema: 'schedule', verbs: 'read+act' }],
          },
        }),
      ),
    });
    expect(withVault).toContain('### Personal vault');
    expect(withVault).toContain('ctx.vault.invoke');
    expect(withVault).toContain('`schedule.*` (read+act)');
    expect(withVault).toContain('plans the day');
  });
});
