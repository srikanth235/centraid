/*
 * The agents-status route reports CLI availability and — when the gateway
 * supplies a per-agent model resolver (issue #188) — each agent's models, so
 * Settings → Agents can offer a per-agent default-model picker independent of
 * which runner is active. These tests cover the resolver plumbing; the CLI
 * probe itself runs for real and is not asserted on (its result varies by host).
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readAgentsStatus } from './agents-routes.ts';

test('omits per-agent models when no resolver is supplied', async () => {
  const s = await readAgentsStatus();
  assert.equal('codexModels' in s, false);
  assert.equal('claudeModels' in s, false);
  assert.equal(typeof s.codexAvailable, 'boolean');
  assert.equal(typeof s.claudeAvailable, 'boolean');
});

test('attaches each agent’s models from the resolver', async () => {
  const calls: Array<[string, boolean]> = [];
  const s = await readAgentsStatus({
    resolveModels: async (kind, refresh) => {
      calls.push([kind, refresh]);
      return kind === 'codex'
        ? [{ id: 'gpt-x', name: 'GPT-X', default: true }]
        : [{ id: 'claude-x', name: 'Claude X' }];
    },
  });
  assert.deepEqual(s.codexModels, [{ id: 'gpt-x', name: 'GPT-X', default: true }]);
  assert.deepEqual(s.claudeModels, [{ id: 'claude-x', name: 'Claude X' }]);
  assert.deepEqual(
    calls.sort((a, b) => a[0].localeCompare(b[0])),
    [
      ['claude-code', false],
      ['codex', false],
    ],
  );
});

test('threads the refresh flag to the resolver for both agents', async () => {
  const seen: boolean[] = [];
  await readAgentsStatus({
    resolveModels: async (_kind, refresh) => {
      seen.push(refresh);
      return [];
    },
    refresh: true,
  });
  assert.deepEqual(seen, [true, true]);
});

test('a throwing resolver degrades that agent to an empty list', async () => {
  const s = await readAgentsStatus({
    resolveModels: async () => {
      throw new Error('boom');
    },
  });
  assert.deepEqual(s.codexModels, []);
  assert.deepEqual(s.claudeModels, []);
});
