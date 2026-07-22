// Core turn behaviour of the generic ACP backend: handshake, streaming,
// resume, cancellation, launch failure, and the auth handshake. Feature areas
// live beside this file (attachments, model + usage, vault tools); shared
// fixtures in test-fixtures.ts.

import { tempDir } from '@centraid/test-kit/temp-dir';
import { expect, test } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { TurnStreamEvent } from '@centraid/app-engine';
import { runAcpTurn } from './backend.ts';
import { deltas, notices, runFake, types } from './test-fixtures.js';

test('normal turn: handshake → stream → tool call → permission → final', async () => {
  const dir = await tempDir('acp-perm-');
  const permMarker = path.join(dir, 'perm');
  const { events, result } = await runFake({
    extraArgs: ['--mode=normal', `--perm-marker=${permMarker}`],
  });

  // Session id from session/new is returned for resume.
  expect(result.sessionId).toBe('sess-1');

  // Continuity / permission notices may precede stream events; assistant
  // text still starts exactly once and final is last.
  const t = types(events);
  expect(t).toContain('assistant.start');
  expect(t).toContain('reasoning.delta');
  expect(t).toContain('tool.start');
  expect(t).toContain('tool.result');
  expect(t.at(-1)).toBe('final');
  expect(notices(events)).toContain('session_continuity');
  expect(notices(events)).toContain('permission_auto_allowed');

  // Streamed assistant text accumulates across chunks.
  expect(deltas(events)).toBe('Hello world');
  const final = events.find((e) => e.type === 'final');
  expect(final && final.type === 'final' && final.text).toBe('Hello world');

  // Tool result maps completed → ok:true.
  const toolResult = events.find((e) => e.type === 'tool.result');
  expect(toolResult && toolResult.type === 'tool.result' && toolResult.ok).toBe(true);
  const toolStart = events.find((e) => e.type === 'tool.start');
  expect(toolStart && toolStart.type === 'tool.start' && toolStart.toolName).toBe('read_file');

  // Permission auto-allow picked the least-destructive allow_always option.
  expect(await fs.readFile(permMarker, 'utf8')).toBe('always');
});

test('resume via session/load reuses the id and swallows replayed history', async () => {
  const { events, result } = await runFake({
    extraArgs: ['--mode=resume'],
    prevSessionId: 'prev-1',
  });

  expect(result.sessionId).toBe('prev-1');
  // History replayed during session/load must not leak into the transcript.
  const allText = JSON.stringify(events);
  expect(allText).not.toContain('HISTORY_USER');
  expect(allText).not.toContain('HISTORY_AGENT');
  expect(deltas(events)).toBe('Hello world');
  expect(types(events).at(-1)).toBe('final');
});

test('cancellation mid-stream sends session/cancel and emits aborted', async () => {
  const dir = await tempDir('acp-cancel-');
  const cancelMarker = path.join(dir, 'cancel');
  const { events } = await runFake({
    extraArgs: ['--mode=cancel', `--cancel-marker=${cancelMarker}`],
    // Abort as soon as the first streamed chunk arrives.
    abortOn: (e) => e.type === 'assistant.delta',
  });

  // The agent observed session/cancel (wrote its marker).
  expect(await fs.readFile(cancelMarker, 'utf8')).toBe('cancelled');
  // Our side emits `aborted` and suppresses `final` once aborted.
  expect(types(events)).toContain('aborted');
  expect(types(events)).not.toContain('final');
});

test('spawn/nonzero-exit failure surfaces an error event', async () => {
  const { events } = await runFake({ extraArgs: ['--mode=exit'] });
  const err = events.find((e) => e.type === 'error');
  expect(err && err.type === 'error').toBe(true);
});

test('no configured binary reports an actionable error (custom acp kind)', async () => {
  const cwd = await tempDir('acp-nobin-');
  const events: TurnStreamEvent[] = [];
  const result = await runAcpTurn(
    {
      cwd,
      message: 'hi',
      extraSystemPrompt: '',
      abortSignal: new AbortController().signal,
      onEvent: (e) => events.push(e),
    },
    { kind: 'acp', acpArgs: [] },
  );
  expect(result.sessionId).toBeUndefined();
  const err = events.find((e) => e.type === 'error');
  expect(err && err.type === 'error' && /binary/i.test(err.message)).toBe(true);
});

// ---- auth handshake -------------------------------------------------------

test('AUTH_REQUIRED becomes an actionable message, not a raw RPC error', async () => {
  const { events } = await runFake({
    extraArgs: ['--mode=auth'],
    label: 'Gemini CLI',
    installHint: 'Install Gemini CLI (`npm i -g @google/gemini-cli`) and run `gemini` once.',
  });
  const err = events.find((e) => e.type === 'error');
  const message = err && err.type === 'error' ? err.message : '';
  expect(message).toContain('Gemini CLI');
  expect(message).toContain('isn’t signed in');
  expect(message).toContain('run `gemini` once');
  // The raw JSON-RPC wording never reaches the transcript.
  expect(message).not.toContain('acp rpc');
  expect(message).not.toContain('-32000');
});

// ---- stopReason / continuity / policy / permissions -----------------------

test('refusal stopReason is an error without final', async () => {
  const { events } = await runFake({ extraArgs: ['--mode=refusal'] });
  expect(types(events)).toContain('error');
  expect(types(events)).not.toContain('final');
  const err = events.find((e) => e.type === 'error');
  expect(err && err.type === 'error' && err.message).toMatch(/refused/i);
});

test('max_tokens stopReason warns then still emits final', async () => {
  const { events } = await runFake({ extraArgs: ['--mode=max_tokens'] });
  expect(notices(events)).toContain('stop_truncated');
  expect(types(events).at(-1)).toBe('final');
});

test('system policy is prepended on every turn including resumed sessions', async () => {
  const dir = await tempDir('acp-sys-');
  const promptMarker = path.join(dir, 'prompt');
  await runFake({
    extraArgs: ['--mode=resume', `--prompt-marker=${promptMarker}`],
    prevSessionId: 'prev-1',
  });
  const blocks = JSON.parse(await fs.readFile(promptMarker, 'utf8')) as Array<{
    type: string;
    text?: string;
  }>;
  expect(blocks[0]).toEqual({ type: 'text', text: 'SYSTEM_CONTEXT' });
  expect(blocks.some((b) => b.text === 'hello agent')).toBe(true);
});

test('session/resume is preferred over session/load when advertised', async () => {
  const { events, result } = await runFake({
    extraArgs: ['--mode=resume-cap', '--session-resume'],
    prevSessionId: 'prev-resume-1',
  });
  expect(result.sessionId).toBe('prev-resume-1');
  expect(notices(events)).toContain('session_continuity');
  // Resume must not leak load-style history replay.
  const allText = JSON.stringify(events);
  expect(allText).not.toContain('HISTORY_USER');
});

test('permission auto-allow emits an audit notice', async () => {
  const { events } = await runFake({ extraArgs: ['--mode=normal'] });
  expect(notices(events)).toContain('permission_auto_allowed');
  expect(notices(events)).toContain('session_continuity');
  const plan = events.find((e) => e.type === 'phase' && e.phase === 'plan');
  expect(plan && plan.type === 'phase' && plan.plan?.length).toBe(2);
  const toolResult = events.find((e) => e.type === 'tool.result');
  expect(toolResult && toolResult.type === 'tool.result' && toolResult.diffs?.[0]?.path).toBe(
    'notes.txt',
  );
});
