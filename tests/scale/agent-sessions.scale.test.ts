import { RUNNER_BACKENDS, runTurn } from "@centraid/agent-runtime";
import type { TurnConfig, TurnInput } from "@centraid/agent-runtime";
import {
  qualityRegressionBudget,
  recordQualityResult,
} from "@centraid/test-kit/quality-result";
import { describe, expect, test } from "vitest";

const OWNER = "tests/scale/agent-sessions.scale.test.ts";
const SESSIONS = 256;

describe("agent-sessions.scale", () => {
  test("fans concurrent sessions through the runner registry", async () => {
    const original = RUNNER_BACKENDS.acp;
    RUNNER_BACKENDS.acp = {
      ...original,
      runTurn: async (input) => ({
        adapterKind: "acp",
        sessionId: String(input.message),
      }),
    };
    try {
      const config: TurnConfig = {
        prefs: { kind: "acp", binPath: "/bin/unused" },
      };
      const started = performance.now();
      const results = await Promise.all(
        Array.from({ length: SESSIONS }, (_, index) =>
          runTurn(
            {
              cwd: process.cwd(),
              message: `session-${index}`,
              extraSystemPrompt: "",
              abortSignal: new AbortController().signal,
              onEvent: () => undefined,
            } as unknown as TurnInput,
            config
          )
        )
      );
      const durationMs = performance.now() - started;
      const budget = await qualityRegressionBudget("scale", OWNER);
      const passed = budget == null || durationMs < budget;
      expect(new Set(results.map((result) => result.sessionId)).size).toBe(
        SESSIONS
      );
      await recordQualityResult({
        lane: "scale",
        owner: OWNER,
        name: `${SESSIONS} concurrent runner sessions`,
        status: passed ? "passed" : "failed",
        measurements: [
          {
            name: "wall clock",
            value: durationMs,
            unit: "ms",
            ...(budget == null ? {} : { budget }),
          },
          { name: "sessions", value: SESSIONS, unit: "count" },
        ],
      });
      expect(passed).toBe(true);
    } finally {
      RUNNER_BACKENDS.acp = original;
    }
  });
});
