import { RUNNER_BACKENDS, runTurn } from "@centraid/agent-runtime";
import type { TurnConfig, TurnInput } from "@centraid/agent-runtime";
import {
  qualityRegressionBudget,
  recordQualityResult,
} from "@centraid/test-kit/quality-result";
import { describe, expect, test } from "vitest";

const OWNER = "tests/perf/agent-turn.perf.test.ts";
const TURNS = 2_000;

describe("agent-turn.perf", () => {
  test("dispatches runner turns through the registry within budget", async () => {
    const original = RUNNER_BACKENDS.acp;
    RUNNER_BACKENDS.acp = {
      ...original,
      runTurn: async () => ({ adapterKind: "acp", sessionId: "perf" }),
    };
    try {
      const input = {
        cwd: process.cwd(),
        message: "perf",
        extraSystemPrompt: "",
        abortSignal: new AbortController().signal,
        onEvent: () => undefined,
      } as unknown as TurnInput;
      const config: TurnConfig = {
        prefs: { kind: "acp", binPath: "/bin/unused" },
      };
      const started = performance.now();
      await Array.from({ length: TURNS }).reduce(async (previous) => {
        await previous;
        await runTurn(input, config);
      }, Promise.resolve());
      const durationMs = performance.now() - started;
      const budget = await qualityRegressionBudget("perf", OWNER);
      const passed = budget == null || durationMs < budget;
      await recordQualityResult({
        lane: "perf",
        owner: OWNER,
        name: `${TURNS} runner turn dispatches`,
        status: passed ? "passed" : "failed",
        measurements: [
          {
            name: "wall clock",
            value: durationMs,
            unit: "ms",
            ...(budget == null ? {} : { budget }),
          },
          { name: "mean dispatch", value: durationMs / TURNS, unit: "ms" },
        ],
      });
      expect(passed).toBe(true);
    } finally {
      RUNNER_BACKENDS.acp = original;
    }
  });
});
