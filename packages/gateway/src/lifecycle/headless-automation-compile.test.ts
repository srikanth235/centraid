import { afterEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ConversationStore,
  makeJournalDbProvider,
  type ConversationRunner,
} from '@centraid/app-engine';
import {
  HEADLESS_COMPILE_WORK_ORDER,
  finalizeCompiledManifest,
  runHeadlessAutomationCompile,
} from './headless-automation-compile.js';
import { validateManifest } from '@centraid/automation';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function harness(runner: ConversationRunner) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'centraid-headless-compile-'));
  dirs.push(dir);
  const journalDbFile = path.join(dir, 'journal.db');
  const onSuccess = vi.fn().mockResolvedValue(undefined);
  const onFailure = vi.fn().mockResolvedValue(undefined);
  await runHeadlessAutomationCompile({
    runner,
    journalDbFile,
    runnerSessionDir: path.join(dir, 'sessions'),
    dataDir: path.join(dir, 'apps'),
    appId: 'digest',
    draftSessionId: 'compile-digest-1',
    automationRef: 'digest/main',
    automationName: 'Daily digest',
    instructions: 'Summarize mail about @[core.party/p-1].',
    onSuccess,
    onFailure,
    runId: 'compile-1',
  });
  return {
    store: new ConversationStore(makeJournalDbProvider(journalDbFile)),
    onSuccess,
    onFailure,
  };
}

describe('runHeadlessAutomationCompile', () => {
  it('records a successful compile turn on the stable automation conversation', async () => {
    let receivedDraftSessionId: string | undefined;
    const runner: ConversationRunner = {
      run: async (input) => {
        receivedDraftSessionId = input.draftSessionId;
        input.onEvent({ type: 'final', text: 'Files ready.' });
        input.onEvent({ type: 'usage', model: 'test-model', inputTokens: 12, outputTokens: 4 });
        return { adapterKind: 'codex' };
      },
    };
    const { store, onSuccess, onFailure } = await harness(runner);
    expect(onSuccess).toHaveBeenCalledOnce();
    expect(onFailure).not.toHaveBeenCalled();
    expect(receivedDraftSessionId).toBe('compile-digest-1');
    expect(store.getConversation('digest/main')?.title).toBe('Daily digest');
    const turn = store.getTurn('compile-1');
    expect(turn?.conversationId).toBe('digest/main');
    expect(turn?.triggerKind).toBe('compile');
    expect(turn?.ok).toBe(true);
    expect(turn?.summary).toBe('Plan ready');
    expect(store.messageInText('compile-1')).toContain(
      "ctx.vault.resolve({ refs: [{ type: 'core.party'",
    );
    expect(store.listItems('compile-1').map((item) => item.kind)).toEqual(['message_in', 'step']);
    store.close();
  });

  it('records failure and does not publish when the runner rejects', async () => {
    const runner: ConversationRunner = {
      run: async () => {
        throw new Error('compiler unavailable');
      },
    };
    const { store, onSuccess, onFailure } = await harness(runner);
    expect(onSuccess).not.toHaveBeenCalled();
    expect(onFailure).toHaveBeenCalledWith('compiler unavailable');
    expect(store.getTurn('compile-1')).toMatchObject({
      ok: false,
      error: 'compiler unavailable',
      summary: 'Compile failed',
    });
    store.close();
  });

  it('frames the model turn as a work order and expands stable entity tokens', () => {
    const prompt = HEADLESS_COMPILE_WORK_ORDER('Notify @[core.event/e-1].');
    expect(prompt).toContain('work order, not a conversation');
    expect(prompt).toContain(
      "@[core.event/e-1] => await ctx.vault.resolve({ refs: [{ type: 'core.event', id: 'e-1' }]",
    );
    expect(prompt).toContain("generated.by = 'centraid-compiler'");
  });

  it('instructs the compiler to pick data/condition triggers over cron polling', () => {
    const prompt = HEADLESS_COMPILE_WORK_ORDER('Reconcile invoices when a transaction posts.');
    expect(prompt).toContain('reacting to vault-data changes, declare a data trigger');
    expect(prompt).toContain('data-state window ("due in N days"), declare a condition trigger');
    expect(prompt).toContain('vault read scopes covering every watched entity');
    expect(prompt).toContain('instead of approximating either with a cron poll');
    expect(prompt).toContain(
      'Leave existing cron/webhook triggers alone unless the instructions changed them.',
    );
  });
});

describe('finalizeCompiledManifest', () => {
  const manifest = () =>
    validateManifest({
      name: 'Digest',
      version: '0.1.0',
      enabled: false,
      prompt: 'Summarize @[core.event/e-1].',
      triggers: [],
      requires: {},
      history: { keep: { count: 50 } },
      generated: { by: 'old', at: '2026-01-01T00:00:00.000Z' },
    });

  it('preserves recompile enablement, enables first compile, and derives tagged scopes', () => {
    const preserved = finalizeCompiledManifest(manifest(), {
      enabledBeforeCompile: true,
      enableOnSuccess: false,
      compiledAt: new Date('2026-07-13T00:00:00.000Z'),
    });
    expect(preserved.enabled).toBe(true);
    expect(preserved.vault?.scopes).toContainEqual({
      schema: 'core',
      table: 'event',
      verbs: 'read',
    });
    expect(preserved.generated).toEqual({
      by: 'centraid-compiler',
      at: '2026-07-13T00:00:00.000Z',
    });

    expect(
      finalizeCompiledManifest(manifest(), {
        enabledBeforeCompile: false,
        enableOnSuccess: true,
      }).enabled,
    ).toBe(true);
  });
});
