/*
 * The agents-status route reports CLI availability and — when the gateway
 * supplies a per-agent model/tool resolver (issue #188) — each agent's models
 * and tools plus their load tri-state, so Settings → Agents can offer a
 * per-agent picker with a loading/empty state. These tests cover the resolver
 * plumbing; the CLI probe itself runs for real and is not asserted on (its
 * result varies by host).
 */

import { expect, test, vi } from 'vitest';
import { readAgentsStatus } from './agents-routes.ts';

vi.setConfig({ testTimeout: 15_000 });

test('omits per-agent models when no resolver is supplied', async () => {
  const s = await readAgentsStatus();
  expect('codexModels' in s).toBe(false);
  expect('claudeModels' in s).toBe(false);
  expect('codexModelsStatus' in s).toBe(false);
  expect(typeof s.codexAvailable).toBe('boolean');
  expect(typeof s.claudeAvailable).toBe('boolean');
});

test('attaches each agent’s models + status from the resolver', async () => {
  const calls: Array<[string, boolean]> = [];
  const s = await readAgentsStatus({
    resolveModels: async (kind, refresh) => {
      calls.push([kind, refresh]);
      return kind === 'codex'
        ? { list: [{ id: 'gpt-x', name: 'GPT-X', default: true }], status: 'ready' }
        : { list: [{ id: 'claude-x', name: 'Claude X' }], status: 'ready' };
    },
  });
  expect(s.codexModels).toEqual([{ id: 'gpt-x', name: 'GPT-X', default: true }]);
  expect(s.claudeModels).toEqual([{ id: 'claude-x', name: 'Claude X' }]);
  expect(s.codexModelsStatus).toBe('ready');
  expect(s.claudeModelsStatus).toBe('ready');
  expect(calls.sort((a, b) => a[0].localeCompare(b[0]))).toEqual([
    ['claude-code', false],
    ['codex', false],
  ]);
});

test('surfaces a loading surface so the client knows to poll', async () => {
  const s = await readAgentsStatus({
    resolveModels: async () => ({ list: [], status: 'loading' }),
  });
  expect(s.codexModels).toEqual([]);
  expect(s.codexModelsStatus).toBe('loading');
  expect(s.claudeModelsStatus).toBe('loading');
});

test('threads the refresh flag to the resolver for both agents', async () => {
  const seen: boolean[] = [];
  await readAgentsStatus({
    resolveModels: async (_kind, refresh) => {
      seen.push(refresh);
      return { list: [], status: 'loading' };
    },
    refresh: true,
  });
  expect(seen).toEqual([true, true]);
});

test('a throwing resolver degrades that agent to an empty list', async () => {
  const s = await readAgentsStatus({
    resolveModels: async () => {
      throw new Error('boom');
    },
  });
  expect(s.codexModels).toEqual([]);
  expect(s.claudeModels).toEqual([]);
  expect(s.codexModelsStatus).toBe('empty');
  expect(s.claudeModelsStatus).toBe('empty');
});

test('omits per-agent tools when no tools resolver is supplied', async () => {
  const s = await readAgentsStatus();
  expect('codexTools' in s).toBe(false);
  expect('claudeTools' in s).toBe(false);
  expect('codexToolsStatus' in s).toBe(false);
});

test('attaches each agent’s tools + status and threads refreshTools independently', async () => {
  const calls: Array<[string, boolean]> = [];
  const s = await readAgentsStatus({
    resolveModels: async () => ({ list: [], status: 'empty' }), // models present but NOT refreshed
    resolveTools: async (kind, refresh) => {
      calls.push([kind, refresh]);
      return {
        list: [{ name: kind === 'codex' ? 'exec_command' : 'Read', source: 'native' }],
        status: 'ready',
      };
    },
    refreshTools: true, // tools refreshed; refresh (models) defaults false
  });
  expect(s.codexTools).toEqual([{ name: 'exec_command', source: 'native' }]);
  expect(s.claudeTools).toEqual([{ name: 'Read', source: 'native' }]);
  expect(s.codexToolsStatus).toBe('ready');
  // refreshTools (not refresh) reached the tools resolver for both agents.
  expect(calls.sort((a, b) => a[0].localeCompare(b[0]))).toEqual([
    ['claude-code', true],
    ['codex', true],
  ]);
});

test('a throwing tools resolver degrades that agent to an empty list', async () => {
  const s = await readAgentsStatus({
    resolveTools: async () => {
      throw new Error('boom');
    },
  });
  expect(s.codexTools).toEqual([]);
  expect(s.claudeTools).toEqual([]);
  expect(s.codexToolsStatus).toBe('empty');
  expect(s.claudeToolsStatus).toBe('empty');
});
