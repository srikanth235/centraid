import { expect, test } from 'vitest';
import { RUNNER_KINDS, isRunnerKind } from './turn.js';

test('RUNNER_KINDS is the source-of-truth list of runner kinds', () => {
  expect(RUNNER_KINDS).toEqual([
    'codex',
    'claude-code',
    'gemini',
    'qwen',
    'opencode',
    'grok',
    'kimi',
    'acp',
  ]);
});

test('isRunnerKind accepts every known kind', () => {
  for (const kind of RUNNER_KINDS) {
    expect(isRunnerKind(kind)).toBe(true);
  }
});

test('isRunnerKind rejects unknown / non-string values', () => {
  expect(isRunnerKind('gpt')).toBe(false);
  expect(isRunnerKind('')).toBe(false);
  expect(isRunnerKind('none')).toBe(false);
  expect(isRunnerKind(undefined)).toBe(false);
  expect(isRunnerKind(null)).toBe(false);
  expect(isRunnerKind(42)).toBe(false);
});
