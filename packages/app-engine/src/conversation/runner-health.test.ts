import { expect, test } from 'vitest';
import { newProvider } from './store-test-fixtures.js';
import { RunnerHealthStore, type RunnerHealthPolicy } from './runner-health.js';
import type { AgentFailureClass } from './runner.js';

const policies = Object.fromEntries(
  ['spawn', 'auth', 'init', 'timeout', 'quota', 'wedge', 'exit', 'unknown'].map((key) => [
    key,
    { threshold: key === 'spawn' ? 2 : 1, cooldownMs: 100 },
  ]),
) as Record<AgentFailureClass, RunnerHealthPolicy>;

test('breakers are persistent and isolated by workspace, runner, and class', () => {
  const provider = newProvider();
  const health = new RunnerHealthStore(provider, policies);

  health.reportFailure('vault-a', 'codex', 'spawn', 'first', 1_000);
  expect(health.canAttempt('vault-a', 'codex', 1_001).allowed).toBe(true);
  health.reportFailure('vault-a', 'codex', 'spawn', 'second', 1_010);
  expect(health.canAttempt('vault-a', 'codex', 1_011)).toMatchObject({
    allowed: false,
    failureClass: 'spawn',
    breakerUntil: 1_110,
  });
  expect(health.canAttempt('vault-b', 'codex', 1_011).allowed).toBe(true);
  expect(health.canAttempt('vault-a', 'claude-code', 1_011).allowed).toBe(true);
  expect(
    new RunnerHealthStore(provider, policies).canAttempt('vault-a', 'codex', 1_011).allowed,
  ).toBe(false);
  expect(health.canAttempt('vault-a', 'codex', 1_111).allowed).toBe(true);
});

test('ordinary success leaves auth open until a real preflight succeeds', () => {
  const health = new RunnerHealthStore(newProvider(), policies);
  health.reportFailure('vault-a', 'codex', 'auth', 'login', 1_000);
  health.reportFailure('vault-a', 'codex', 'quota', '429', 1_000);
  expect(health.canAttempt('vault-a', 'codex', 1_001).allowed).toBe(false);
  health.reportOk('vault-a', 'codex', 1_002);
  expect(health.canAttempt('vault-a', 'codex', 1_003)).toMatchObject({
    allowed: false,
    failureClass: 'auth',
  });
  health.reportPreflightOk('vault-a', 'codex', 1_004);
  expect(health.canAttempt('vault-a', 'codex', 1_005).allowed).toBe(true);
});

test('quota backs off and timeout admits exactly one half-open claimant', () => {
  const health = new RunnerHealthStore(newProvider(), policies);
  health.reportFailure('vault-a', 'codex', 'quota', '429', 1_000);
  expect(health.canAttempt('vault-a', 'codex', 1_050).allowed).toBe(false);
  expect(health.canAttempt('vault-a', 'codex', 1_101).allowed).toBe(true);

  health.reportFailure('vault-a', 'codex', 'timeout', 'hung', 2_000);
  expect(health.canAttempt('vault-a', 'codex', 2_101)).toMatchObject({
    allowed: true,
    halfOpen: true,
  });
  expect(health.canAttempt('vault-a', 'codex', 2_101).allowed).toBe(false);
  expect(health.list('vault-a', 2_101)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        runnerKind: 'codex',
        failureClass: 'timeout',
        state: 'half-open',
      }),
    ]),
  );
});
