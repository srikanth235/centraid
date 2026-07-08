/*
 * Unit tests for the OpenClaw conversation runner's stream translation +
 * turn accounting (issue #319, WS1/WS2). We drive `run()` with a fake
 * `runEmbeddedAgent` that fires the callbacks OpenClaw would, and assert the
 * `TurnStreamEvent`s the harness receives plus the params the embedded run
 * was invoked with (workspaceDir, grounded prompt).
 */

import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { TurnStreamEvent } from '@centraid/app-engine';
import type { VaultRegistry } from '@centraid/gateway';
import { makeOpenClawConversationRunner } from './openclaw-conversation-runner.js';

type EmbeddedParams = Record<string, unknown> & {
  onAssistantMessageStart?: () => void;
  onBlockReply?: (p: { text?: string; isReasoning?: boolean }) => void;
  onAgentEvent?: (e: { stream: string; data: Record<string, unknown> }) => void;
};

function fakeApi(opts: {
  run: (params: EmbeddedParams) => unknown;
  captured: { params?: EmbeddedParams };
}): Parameters<typeof makeOpenClawConversationRunner>[0] {
  return {
    runtime: {
      agent: {
        runEmbeddedAgent: async (params: EmbeddedParams) => {
          opts.captured.params = params;
          return opts.run(params);
        },
      },
    },
  } as unknown as Parameters<typeof makeOpenClawConversationRunner>[0];
}

function fakeRegistry(): Promise<VaultRegistry> {
  return Promise.resolve({
    current: () => ({ name: 'My Vault', assistantContext: () => 'SCHEMA-MAP' }),
  } as unknown as VaultRegistry);
}

function baseInput(events: TurnStreamEvent[]) {
  return {
    appId: 'todos',
    dataDir: '/tmp/data',
    conversationId: 'c1',
    sessionFile: '/vault-a/runner-sessions/c1.jsonl',
    message: 'hello',
    extraSystemPrompt: '## App context',
    abortSignal: new AbortController().signal,
    onEvent: (e: TurnStreamEvent) => events.push(e),
  };
}

describe('makeOpenClawConversationRunner', () => {
  it('maps the tool agent-event stream to tool.start/tool.result with real names', async () => {
    const events: TurnStreamEvent[] = [];
    const captured: { params?: EmbeddedParams } = {};
    const api = fakeApi({
      captured,
      run: (params) => {
        params.onAssistantMessageStart?.();
        params.onAgentEvent?.({
          stream: 'tool',
          data: { phase: 'start', name: 'vault_sql', toolCallId: 't1', args: { sql: 'SELECT 1' } },
        });
        params.onAgentEvent?.({
          stream: 'tool',
          data: { phase: 'update', name: 'vault_sql', toolCallId: 't1' },
        });
        params.onAgentEvent?.({
          stream: 'tool',
          data: { phase: 'result', name: 'vault_sql', toolCallId: 't1', isError: false },
        });
        params.onBlockReply?.({ text: 'done' });
        return { payloads: [{ text: 'done' }], meta: { durationMs: 1 } };
      },
    });
    const runner = makeOpenClawConversationRunner(api, fakeRegistry());
    await runner.run(baseInput(events));

    const start = events.find((e) => e.type === 'tool.start');
    const result = events.find((e) => e.type === 'tool.result');
    expect(start).toMatchObject({ toolName: 'vault_sql', toolCallId: 't1', sql: 'SELECT 1' });
    expect(result).toMatchObject({ toolName: 'vault_sql', toolCallId: 't1', ok: true });
    // The `update` phase is not surfaced.
    expect(events.filter((e) => e.type === 'phase')).toHaveLength(0);
  });

  it('marks tool.result not-ok when the agent-event reports an error', async () => {
    const events: TurnStreamEvent[] = [];
    const captured: { params?: EmbeddedParams } = {};
    const api = fakeApi({
      captured,
      run: (params) => {
        params.onAgentEvent?.({
          stream: 'tool',
          data: { phase: 'result', name: 'vault_invoke', toolCallId: 'x', isError: true },
        });
        return { payloads: [], meta: { durationMs: 1 } };
      },
    });
    await makeOpenClawConversationRunner(api, fakeRegistry()).run(baseInput(events));
    expect(events.find((e) => e.type === 'tool.result')).toMatchObject({
      toolName: 'vault_invoke',
      ok: false,
    });
  });

  it('emits a usage event folded from the run metadata', async () => {
    const events: TurnStreamEvent[] = [];
    const captured: { params?: EmbeddedParams } = {};
    const api = fakeApi({
      captured,
      run: () => ({
        payloads: [{ text: 'ok' }],
        meta: {
          durationMs: 1,
          agentMeta: {
            provider: 'anthropic',
            model: 'claude-x',
            usage: { input: 100, output: 20, cacheRead: 8, cacheWrite: 4 },
          },
        },
      }),
    });
    await makeOpenClawConversationRunner(api, fakeRegistry()).run(baseInput(events));
    expect(events.find((e) => e.type === 'usage')).toEqual({
      type: 'usage',
      provider: 'anthropic',
      model: 'claude-x',
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 8,
      cacheWriteTokens: 4,
    });
  });

  it('omits the usage event when the run reports no accounting', async () => {
    const events: TurnStreamEvent[] = [];
    const captured: { params?: EmbeddedParams } = {};
    const api = fakeApi({ captured, run: () => ({ payloads: [], meta: { durationMs: 1 } }) });
    await makeOpenClawConversationRunner(api, fakeRegistry()).run(baseInput(events));
    expect(events.some((e) => e.type === 'usage')).toBe(false);
  });

  it('scopes the workspace dir under the vault runner-session dir (not os.homedir)', async () => {
    const events: TurnStreamEvent[] = [];
    const captured: { params?: EmbeddedParams } = {};
    const api = fakeApi({ captured, run: () => ({ payloads: [], meta: { durationMs: 1 } }) });
    await makeOpenClawConversationRunner(api, fakeRegistry()).run(baseInput(events));
    expect(captured.params?.workspaceDir).toBe(
      path.join('/vault-a/runner-sessions', '_conversation-workspace'),
    );
  });

  it('appends the vault-register grounding to the app-context preamble', async () => {
    const events: TurnStreamEvent[] = [];
    const captured: { params?: EmbeddedParams } = {};
    const api = fakeApi({ captured, run: () => ({ payloads: [], meta: { durationMs: 1 } }) });
    await makeOpenClawConversationRunner(api, fakeRegistry()).run(baseInput(events));
    const prompt = captured.params?.extraSystemPrompt as string;
    expect(prompt.startsWith('## App context')).toBe(true);
    expect(prompt).toContain('My Vault');
    expect(prompt).toContain('SCHEMA-MAP');
  });
});
