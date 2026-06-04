import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { RUNNER_TIERS } from './model-tiers.js';
import { resolveClaudeModel } from '../backends/claude-sdk.js';

test('claude-code offers capability tiers with exactly one default', () => {
  const tiers = RUNNER_TIERS['claude-code'];
  assert.ok(tiers && tiers.length > 0, 'claude-code has tiers');
  assert.equal(tiers.filter((t) => t.default).length, 1, 'exactly one default');
  const ids = tiers.map((t) => t.id);
  assert.deepEqual(ids, ['smart', 'balanced', 'fast']);
});

test('codex is not given tiers (stays on gateway default)', () => {
  assert.equal(RUNNER_TIERS.codex, undefined);
});

test('resolveClaudeModel maps tiers to CLI aliases, passes others through', () => {
  assert.equal(resolveClaudeModel('smart'), 'opus');
  assert.equal(resolveClaudeModel('balanced'), 'sonnet');
  assert.equal(resolveClaudeModel('fast'), 'haiku');
  // Full ids / unknown tokens pass through unchanged.
  assert.equal(resolveClaudeModel('claude-opus-4-8'), 'claude-opus-4-8');
  assert.equal(resolveClaudeModel(''), '');
});
