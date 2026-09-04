import { describe, expect, test } from "vitest";

import { HARNESSES, runTurn } from "@centraid/server/acp";
import type { TurnConfig, TurnInput } from "@centraid/server/acp";
import { recordQualityResult } from "@centraid/test-kit/quality-result";

const OWNER = "tests/scale/harness-sessions.scale.test.ts";
const SESSIONS = 256;

describe("harness-sessions.scale", () => {
  test("fans concurrent sessions through the harness registry", async () => {
    const original = HARNESSES.acp;
    HARNESSES.acp = {
      ...original,
      runTurn: async (input) => ({
        harnessKind: "acp",
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
      // Published, not gated (#927): the paired candidate/PR run compares two
      // trees; a threshold on one sample here would fence the runner.
      const passed = true;
      expect(new Set(results.map((result) => result.sessionId)).size).toBe(
        SESSIONS
      );
      await recordQualityResult({
        lane: "scale",
        owner: OWNER,
        name: `${SESSIONS} concurrent harness sessions`,
        status: passed ? "passed" : "failed",
        measurements: [
          {
            name: "wall clock",
            value: durationMs,
            unit: "ms",
          },
          { name: "sessions", value: SESSIONS, unit: "count" },
        ],
      });
      expect(passed).toBe(true);
    } finally {
      HARNESSES.acp = original;
    }
  });
});
