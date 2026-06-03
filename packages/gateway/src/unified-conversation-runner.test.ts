/*
 * Unified chat runner (issue #141, Phase 3). One chat surface, both jobs:
 * a turn runs in the app's draft session worktree (native file edits stage
 * there) with the union of tools (the `centraid_*` dispatcher threaded via
 * `toolContext` alongside the adapter's native file tools), the unified
 * system prompt (data preamble + builder authoring blocks), and post-turn
 * webhook minting surfaced once via a `webhooks` event.
 *
 * The real turn would spawn codex / claude, so we inject a fake `runTurn`
 * that records what it was handed and simulates the agent authoring an
 * automation with a pending webhook trigger. Tools enumeration is injected
 * empty to stay hermetic (no CLI on the box).
 */

import { test, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { WorktreeStore } from './worktree-store/index.js';
import type { Dispatcher, ConversationTurnInput, TurnStreamEvent } from '@centraid/app-engine';
import type { AgentTurnInput, AgentTurnConfig, AgentTurnResult } from '@centraid/agent-runtime';
import { makeUnifiedConversationRunner } from './unified-conversation-runner.ts';

let root: string;
let store: WorktreeStore;

const dispatcher = { describe: 0 } as unknown as Dispatcher;

function baseInput(
  over: Partial<ConversationTurnInput>,
  onEvent: (e: TurnStreamEvent) => void,
): ConversationTurnInput {
  return {
    appId: 'notes',
    dataDir: path.join(root, 'data', 'notes'),
    conversationId: 'win-1',
    sessionFile: path.join(root, 'sessions', 'win-1.jsonl'),
    message: 'add a webhook automation',
    extraSystemPrompt: 'BASE_DATA_PREAMBLE',
    abortSignal: new AbortController().signal,
    onEvent,
    ...over,
  };
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), `gw-unified-${crypto.randomUUID()}-`));
  store = new WorktreeStore({ root: path.join(root, 'code') });
  await store.init();
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

test('runs the turn in the draft worktree with the union of tools + builder prompt', async () => {
  let captured: { input: AgentTurnInput; config: AgentTurnConfig } | undefined;
  const events: TurnStreamEvent[] = [];

  const runner = makeUnifiedConversationRunner({
    store,
    prefsLoader: async () => ({ kind: 'codex' }),
    getDispatcher: () => dispatcher,
    publicBaseUrl: () => 'http://127.0.0.1:9999',
    enumerateTools: async () => [],
    runTurn: async (input, config): Promise<AgentTurnResult> => {
      captured = { input, config };
      input.onEvent({ type: 'assistant.delta', delta: 'ok' });
      input.onEvent({ type: 'final', text: 'done' });
      return { adapterKind: 'codex', sessionId: 'thread-1' };
    },
  });

  const result = await runner.run(baseInput({}, (e) => events.push(e)));

  // cwd is the app's draft worktree app dir under the host-neutral `chat-<appId>` default session.
  const expectedCwd = await store.snapshotSessionAppDir('chat-notes', 'notes');
  assert.equal(captured?.input.cwd, expectedCwd);

  // Union of tools: the `centraid_*` dispatcher is threaded for this app.
  assert.equal(captured?.input.toolContext?.appId, 'notes');
  assert.equal(captured?.input.toolContext?.dispatcher, dispatcher);

  // Unified prompt: the data preamble is kept AND the builder authoring
  // block is folded in (app kind → CENTRAID_APPEND_PROMPT).
  assert.match(captured!.input.extraSystemPrompt, /BASE_DATA_PREAMBLE/);
  assert.ok(
    captured!.input.extraSystemPrompt.length > 'BASE_DATA_PREAMBLE'.length + 100,
    'builder authoring blocks were folded into the prompt',
  );

  // This IS the builder surface — the route reads `runKind` to persist its
  // turns as `kind: 'build'` in the ledger (#181).
  assert.equal(runner.runKind, 'build');

  // Resume handle round-trips back to the route.
  assert.equal(result?.adapterKind, 'codex');
  assert.equal(result?.adapterSessionId, 'thread-1');

  // Stream events flowed through.
  assert.ok(events.some((e) => e.type === 'final'));
});

test('mints a pending webhook authored during the turn and surfaces it once', async () => {
  const events: TurnStreamEvent[] = [];

  const runner = makeUnifiedConversationRunner({
    store,
    prefsLoader: async () => ({ kind: 'codex' }),
    getDispatcher: () => dispatcher,
    publicBaseUrl: () => 'http://127.0.0.1:9999',
    enumerateTools: async () => [],
    runTurn: async (input): Promise<AgentTurnResult> => {
      // The agent authors an automation with a PENDING webhook trigger —
      // it can't mint crypto-random credentials itself.
      const autoDir = path.join(input.cwd, 'automations', 'notify');
      await fs.mkdir(autoDir, { recursive: true });
      await fs.writeFile(
        path.join(autoDir, 'automation.json'),
        JSON.stringify(
          {
            name: 'Notify',
            version: '0.1.0',
            enabled: true,
            prompt: 'fire on webhook',
            triggers: [{ kind: 'webhook', pending: true }],
            requires: {},
            history: { keep: { count: 50 } },
            generated: { by: 'test', at: '2026-05-22' },
          },
          null,
          2,
        ),
        'utf8',
      );
      await fs.writeFile(
        path.join(autoDir, 'handler.js'),
        'export default async () => ({});',
        'utf8',
      );
      return { adapterKind: 'codex', sessionId: 'thread-2' };
    },
  });

  await runner.run(baseInput({ appId: 'notes' }, (e) => events.push(e)));

  const webhookEvents = events.filter((e) => e.type === 'webhooks');
  assert.equal(webhookEvents.length, 1, 'exactly one webhooks event');
  const evt = webhookEvents[0] as Extract<TurnStreamEvent, { type: 'webhooks' }>;
  assert.equal(evt.minted.length, 1);
  const minted = evt.minted[0]!;
  assert.equal(minted.automationId, 'notify');
  assert.equal(minted.ownerApp, 'notes');
  assert.ok(minted.secret.length > 0, 'a plaintext secret is surfaced once');
  assert.match(minted.url, /^http:\/\/127\.0\.0\.1:9999\/_centraid-hook\//);

  // The staged manifest no longer carries the plaintext secret — only a hash.
  const appDir = await store.snapshotSessionAppDir('chat-notes', 'notes');
  const raw = await fs.readFile(
    path.join(appDir, 'automations', 'notify', 'automation.json'),
    'utf8',
  );
  const parsed = JSON.parse(raw) as {
    triggers: Array<{ kind: string; secretHash?: string; pending?: boolean }>;
  };
  const trig = parsed.triggers[0]!;
  assert.equal(trig.kind, 'webhook');
  assert.ok(trig.secretHash, 'trigger rewritten with a secret hash');
  assert.ok(!trig.pending, 'pending flag cleared after minting');
});

test('errors when no coding agent is configured', async () => {
  const events: TurnStreamEvent[] = [];
  const runner = makeUnifiedConversationRunner({
    store,
    prefsLoader: async () => undefined,
    getDispatcher: () => dispatcher,
    publicBaseUrl: () => 'http://127.0.0.1:9999',
    enumerateTools: async () => [],
    runTurn: async (): Promise<AgentTurnResult> => {
      throw new Error('should not be called');
    },
  });

  await assert.rejects(() => runner.run(baseInput({}, (e) => events.push(e))));
  assert.ok(events.some((e) => e.type === 'error'));
});
