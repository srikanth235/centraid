import { expect, test } from 'vitest';
import { RUNNER_TIERS } from './tiers.js';
import { resolveClaudeModel } from '../backends/claude/backend.js';

test('claude-code offers capability tiers with exactly one default', () => {
  const tiers = RUNNER_TIERS['claude-code'];
  expect(tiers && tiers.length > 0).toBeTruthy();
  expect(tiers!.filter((t) => t.default).length).toBe(1);
  const ids = tiers!.map((t) => t.id);
  expect(ids).toEqual(['smart', 'balanced', 'fast']);
});

test('codex is not given tiers (stays on gateway default)', () => {
  expect(RUNNER_TIERS.codex).toBe(undefined);
});

test('resolveClaudeModel maps tiers to CLI aliases, passes others through', () => {
  expect(resolveClaudeModel('smart')).toBe('opus');
  expect(resolveClaudeModel('balanced')).toBe('sonnet');
  expect(resolveClaudeModel('fast')).toBe('haiku');
  // Full ids / unknown tokens pass through unchanged.
  expect(resolveClaudeModel('claude-opus-4-8')).toBe('claude-opus-4-8');
  expect(resolveClaudeModel('')).toBe('');
});
