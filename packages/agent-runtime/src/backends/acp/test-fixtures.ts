// Shared fixtures for the ACP backend suite: one helper that drives a real
// `runAcpTurn` against the scripted `fake-acp-agent.mjs`, plus the event
// selectors every feature file asserts through. Split across
// backend.test.ts (core turn), backend.attachments.test.ts,
// backend.model-usage.test.ts, and backend.vault-tools.test.ts.

import { tempDir } from '@centraid/test-kit/temp-dir';
import { fileURLToPath } from 'node:url';
import type { ToolContext, TurnStreamEvent } from '@centraid/app-engine';
import { runAcpTurn, type AcpTurnConfig } from './backend.js';

export const FAKE_AGENT = fileURLToPath(new URL('fake-acp-agent.mjs', import.meta.url));

export interface RunOptions {
  extraArgs: string[];
  prevSessionId?: string;
  model?: string;
  attachments?: { path: string; mime: string; filename?: string }[];
  resolveModel?: (model: string) => string;
  toolContext?: ToolContext;
  label?: string;
  installHint?: string;
  /** Called with each event as it arrives — return true to abort the turn. */
  abortOn?: (event: TurnStreamEvent) => boolean;
}

export async function runFake(opts: RunOptions): Promise<{
  events: TurnStreamEvent[];
  result: { sessionId?: string };
}> {
  const cwd = await tempDir('acp-backend-');
  const events: TurnStreamEvent[] = [];
  const controller = new AbortController();
  const config: AcpTurnConfig = {
    kind: 'acp',
    acpArgs: [],
    binPath: FAKE_AGENT,
    extraArgs: opts.extraArgs,
    ...(opts.label ? { label: opts.label } : {}),
    ...(opts.installHint ? { installHint: opts.installHint } : {}),
    ...(opts.resolveModel ? { resolveModel: opts.resolveModel } : {}),
  };
  const result = await runAcpTurn(
    {
      cwd,
      message: 'hello agent',
      extraSystemPrompt: 'SYSTEM_CONTEXT',
      ...(opts.prevSessionId ? { prevSessionId: opts.prevSessionId } : {}),
      ...(opts.model ? { model: opts.model } : {}),
      ...(opts.attachments ? { attachments: opts.attachments } : {}),
      ...(opts.toolContext ? { toolContext: opts.toolContext } : {}),
      abortSignal: controller.signal,
      onEvent: (e) => {
        events.push(e);
        if (opts.abortOn?.(e)) controller.abort();
      },
    },
    config,
  );
  return { events, result };
}

/**
 * A `ToolContext` carrying only what the vault MCP server reads. The rest of
 * the interface belongs to the app-scoped dispatch path, which this endpoint
 * never touches.
 */
export function vaultToolContext(
  over: Partial<ToolContext> = {},
): ToolContext & { calls: Array<{ sql: unknown }> } {
  const calls: Array<{ sql: unknown }> = [];
  return {
    appId: 'test-app',
    turnId: 'turn-1',
    dispatcher: null as unknown as ToolContext['dispatcher'],
    vaultSql: (sql: string) => {
      calls.push({ sql });
      return Promise.resolve({ rows: [{ one: 1 }] });
    },
    calls,
    ...over,
  } as ToolContext & { calls: Array<{ sql: unknown }> };
}

export const types = (events: TurnStreamEvent[]): string[] => events.map((e) => e.type);

export const deltas = (events: TurnStreamEvent[]): string =>
  events
    .filter(
      (e): e is Extract<TurnStreamEvent, { type: 'assistant.delta' }> =>
        e.type === 'assistant.delta',
    )
    .map((e) => e.delta)
    .join('');

export const notices = (events: TurnStreamEvent[]): string[] =>
  events
    .filter((e): e is Extract<TurnStreamEvent, { type: 'notice' }> => e.type === 'notice')
    .map((e) => e.code ?? '');

export const usageOf = (
  events: TurnStreamEvent[],
): Extract<TurnStreamEvent, { type: 'usage' }> | undefined =>
  events.find((e): e is Extract<TurnStreamEvent, { type: 'usage' }> => e.type === 'usage');
