import { describe, expect, it } from "vitest";

import { HarnessSessions } from "./harness-sessions.js";
import type { HarnessSessionBinding } from "./harness-sessions.js";
import type { HydrationMessage } from "./hydration.js";
import { TURN_HYDRATION_TOKEN_BUDGET } from "./turn-plane.js";
import type { HarnessKind } from "./turn.js";

describe(HarnessSessions, () => {
  it("keeps independent plans and observations for each harness", () => {
    const bindings = new Map<HarnessKind, HarnessSessionBinding>([
      ["codex", { sessionId: "codex-1", hydratedThroughSeq: 4 }],
      ["claude-code", { sessionId: "claude-1", hydratedThroughSeq: 8 }],
    ]);
    const requestedWatermarks: number[] = [];
    const sessions = new HarnessSessions({
      binding: (kind) => bindings.get(kind),
      messages: (afterSeq) => {
        requestedWatermarks.push(afterSeq);
        return [
          {
            payload: {
              kind: "user",
              text: `ledger delta after ${afterSeq}`,
            },
          },
          { payload: { kind: "ai", text: "answer" } },
        ];
      },
    });

    expect(sessions.plan("codex").sessionId).toBe("codex-1");
    expect(sessions.plan("claude-code").sessionId).toBe("claude-1");
    expect(requestedWatermarks).toStrictEqual([4, -1, 8, -1]);

    sessions.observe({ kind: "codex", sessionId: "codex-2" });
    sessions.observe({ kind: "claude-code", sessionId: "claude-2" });
    expect(sessions.allObservations()).toStrictEqual([
      { kind: "codex", sessionId: "codex-2" },
      { kind: "claude-code", sessionId: "claude-2" },
    ]);
    expect(sessions.lastObservation()).toStrictEqual({
      kind: "claude-code",
      sessionId: "claude-2",
    });
    expect(sessions.plan("codex")).toStrictEqual({ sessionId: "codex-2" });
    expect(sessions.plan("claude-code")).toStrictEqual({
      sessionId: "claude-2",
    });
  });

  it("uses the shared 8k hydration budget with the two-turn floor", () => {
    const messages: HydrationMessage[] = Array.from(
      { length: 6 },
      (_, index) => [
        {
          payload: {
            kind: "user" as const,
            text: `u${index} ${"x".repeat(10_000)}`,
          },
        },
        {
          payload: {
            kind: "ai" as const,
            text: `a${index} ${"y".repeat(10_000)}`,
          },
        },
      ]
    ).flat();
    const sessions = new HarnessSessions({
      binding: () => undefined,
      messages: () => messages,
    });
    const plan = sessions.plan("codex").hydrationContext;

    expect(plan?.estimatedTokens).toBeLessThanOrEqual(
      TURN_HYDRATION_TOKEN_BUDGET
    );
    expect(plan?.includedTurns).toBeGreaterThanOrEqual(2);
    expect(plan?.prompt).toContain("u5");
  });
});
