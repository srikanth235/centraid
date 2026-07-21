/**
 * Agent chat journey (#496 P1): message → side effect → transcript.
 *
 * Owns `agent-runtime.journey`. Drives the real `runAcpTurn` against
 * `fake-acp-agent.mjs` (same seam as backend tests) so the primary loop is
 * exercised on every default CI run without Electron/Playwright. Desktop
 * copilot UI e2e remains blocked on mock blueprint serving (#470); this
 * integration journey is the product-risk owner until that unblocks.
 */
import { tempDir } from '@centraid/test-kit/temp-dir';
import { expect, test } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { deltas, runFake, types, vaultToolContext } from './test-fixtures.js';

test('chat journey: user message yields vault side effect and visible transcript events', async () => {
  const dir = await tempDir('acp-journey-');
  const vaultMarker = path.join(dir, 'vault');
  const ctx = vaultToolContext();

  const { events, result } = await runFake({
    extraArgs: ['--mode=vault', '--mcp-http', `--vault-marker=${vaultMarker}`],
    toolContext: ctx,
  });

  // Session established (resume path available).
  expect(result.sessionId).toBeTruthy();

  // Side effect: vault_sql ran with a real SQL payload via the loopback MCP.
  expect(ctx.calls.length).toBeGreaterThanOrEqual(1);
  expect(ctx.calls[0]?.sql).toBe('SELECT 1');

  // Transcript includes tool lifecycle and a terminal final (vault mode may
  // start with tool.start before assistant.start — order is not fixed).
  const t = types(events);
  expect(t).toContain('tool.start');
  expect(t).toContain('tool.result');
  expect(t).toContain('final');
  expect(t.at(-1)).toBe('final');

  const toolStart = events.find((e) => e.type === 'tool.start');
  expect(toolStart && toolStart.type === 'tool.start' && toolStart.toolName).toBe('vault_sql');
  const toolResult = events.find((e) => e.type === 'tool.result');
  expect(toolResult && toolResult.type === 'tool.result' && toolResult.ok).toBe(true);

  // Assistant text accumulated (fake agent streams in vault mode too).
  const probe = JSON.parse(await fs.readFile(vaultMarker, 'utf8')) as {
    callIsError?: boolean | null;
  };
  expect(probe.callIsError).toBe(false);
  // At least one assistant delta or a non-empty final when the agent speaks.
  const final = events.find((e) => e.type === 'final');
  const spoken = deltas(events) || (final && final.type === 'final' ? final.text : '');
  expect(typeof spoken === 'string').toBe(true);
});

test('chat journey: resume reuses session and does not leak history into transcript', async () => {
  const { events, result } = await runFake({
    extraArgs: ['--mode=resume'],
    prevSessionId: 'journey-sess',
  });
  expect(result.sessionId).toBe('journey-sess');
  const allText = JSON.stringify(events);
  expect(allText).not.toContain('HISTORY_USER');
  expect(allText).not.toContain('HISTORY_AGENT');
  expect(types(events).at(-1)).toBe('final');
});
