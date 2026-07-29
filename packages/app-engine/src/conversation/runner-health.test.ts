import { describe, expect, test } from "vitest";

import { RunnerHealthStore } from "./runner-health.js";
import type { RunnerHealthPolicy } from "./runner-health.js";
import type { AgentFailureClass } from "./runner.js";
import { newProvider } from "./store-test-fixtures.js";

const policies = Object.fromEntries(
  ["spawn", "auth", "init", "timeout", "quota", "wedge", "exit", "unknown"].map(
    (key) => [key, { threshold: key === "spawn" ? 2 : 1, cooldownMs: 100 }]
  )
) as Record<AgentFailureClass, RunnerHealthPolicy>;
describe("runner-health suite", () => {
  test("breakers are persistent and isolated by workspace, runner, and class", () => {
    const provider = newProvider();
    const health = new RunnerHealthStore(provider, policies);

    health.reportFailure("vault-a", "codex", "spawn", "first", 1_000);
    expect(health.canAttempt("vault-a", "codex", 1_001).allowed).toBe(true);
    health.reportFailure("vault-a", "codex", "spawn", "second", 1_010);
    expect(health.canAttempt("vault-a", "codex", 1_011)).toMatchObject({
      allowed: false,
      failureClass: "spawn",
      breakerUntil: 1_110,
    });
    expect(health.canAttempt("vault-b", "codex", 1_011).allowed).toBe(true);
    expect(health.canAttempt("vault-a", "claude-code", 1_011).allowed).toBe(
      true
    );
    expect(
      new RunnerHealthStore(provider, policies).canAttempt(
        "vault-a",
        "codex",
        1_011
      ).allowed
    ).toBe(false);
    expect(health.canAttempt("vault-a", "codex", 1_111).allowed).toBe(true);
  });

  test("ordinary success leaves auth open until a real preflight succeeds", () => {
    const health = new RunnerHealthStore(newProvider(), policies);
    health.reportFailure("vault-a", "codex", "auth", "login", 1_000);
    health.reportFailure("vault-a", "codex", "quota", "429", 1_000);
    expect(health.canAttempt("vault-a", "codex", 1_001).allowed).toBe(false);
    health.reportOk("vault-a", "codex", 1_002);
    expect(health.canAttempt("vault-a", "codex", 1_003)).toMatchObject({
      allowed: false,
      failureClass: "auth",
    });
    health.reportPreflightOk("vault-a", "codex", 1_004);
    expect(health.canAttempt("vault-a", "codex", 1_005).allowed).toBe(true);
  });

  test("quota backs off and timeout admits exactly one half-open claimant", () => {
    const health = new RunnerHealthStore(newProvider(), policies);
    health.reportFailure("vault-a", "codex", "quota", "429", 1_000);
    expect(health.canAttempt("vault-a", "codex", 1_050).allowed).toBe(false);
    expect(health.canAttempt("vault-a", "codex", 1_101).allowed).toBe(true);

    health.reportFailure("vault-a", "codex", "timeout", "hung", 2_000);
    expect(health.canAttempt("vault-a", "codex", 2_101)).toMatchObject({
      allowed: true,
      halfOpen: true,
    });
    expect(health.canAttempt("vault-a", "codex", 2_101).allowed).toBe(false);
    expect(health.list("vault-a", 2_101)).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          runnerKind: "codex",
          failureClass: "timeout",
          state: "half-open",
        }),
      ])
    );
  });

  test("list reports open and closed breaker metadata across all workspaces", () => {
    const health = new RunnerHealthStore(newProvider(), policies);
    health.reportFailure("vault-a", "codex", "spawn", "first failure", 1_000);
    health.reportFailure("vault-a", "codex", "spawn", "second failure", 1_010);

    expect(health.list(undefined, 1_011)).toStrictEqual([
      expect.objectContaining({
        workspaceContext: "vault-a",
        runnerKind: "codex",
        failureClass: "spawn",
        consecutiveFailures: 2,
        state: "open",
        breakerUntil: 1_110,
        lastError: "second failure",
        lastFailureAt: 1_010,
      }),
    ]);

    health.reportOk("vault-a", "codex", 1_020);
    expect(health.list()).toStrictEqual([
      expect.objectContaining({
        workspaceContext: "vault-a",
        runnerKind: "codex",
        failureClass: "spawn",
        consecutiveFailures: 0,
        state: "closed",
        lastOkAt: 1_020,
      }),
    ]);
  });
});
