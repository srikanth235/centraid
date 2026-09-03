import { describe, expect, it } from "vitest";

import { redactedSteps } from "./spawn.mjs";

describe("redactedSteps", () => {
  const TICKET = "ctk_live_9f2a4c8e1b7d3a6f5e0c";

  it("keeps the step lines that name the failed directive", () => {
    const steps = redactedSteps(
      [
        'Tap on "Paste the one-line ticket"... COMPLETED',
        "Hide Keyboard... COMPLETED",
        'Assert that "Who.s using this phone[?]" is visible... FAILED',
      ].join("\n")
    );
    expect(steps).toHaveLength(3);
    expect(steps[2]).toContain("FAILED");
  });

  it("drops everything that is not a step line", () => {
    const steps = redactedSteps(
      [
        "Running on emulator-5554",
        `Env: MAESTRO_PAIRING_TICKET=${TICKET}`,
        "Launch app... COMPLETED",
      ].join("\n")
    );
    expect(steps).toEqual(["Launch app... COMPLETED"]);
    expect(steps.join("\n")).not.toContain(TICKET);
  });

  it("redacts a secret that reaches a step line anyway", () => {
    const steps = redactedSteps(`Input text ${TICKET}... COMPLETED`, [TICKET]);
    expect(steps).toEqual(["Input text «redacted»... COMPLETED"]);
    expect(steps.join("\n")).not.toContain(TICKET);
  });

  it("redacts every secret it is given, not just the first", () => {
    const other = "tok_second_value";
    const steps = redactedSteps(
      `Input text ${TICKET} then ${other}... FAILED`,
      [TICKET, other]
    );
    expect(steps.join("\n")).not.toContain(TICKET);
    expect(steps.join("\n")).not.toContain(other);
  });

  it("ignores empty and non-string secrets", () => {
    const steps = redactedSteps("Launch app... COMPLETED", [
      "",
      undefined,
      null,
      7,
    ]);
    expect(steps).toEqual(["Launch app... COMPLETED"]);
  });

  it("bounds the output so a failure cannot become a dump", () => {
    const many = Array.from(
      { length: 40 },
      (_, index) => `Step ${index}... COMPLETED`
    ).join("\n");
    const steps = redactedSteps(many);
    expect(steps).toHaveLength(12);
    expect(steps.at(-1)).toBe("Step 39... COMPLETED");
  });

  it("says nothing when no line is in step-line shape", () => {
    expect(redactedSteps("java.lang.Exception: boom\n  at Foo.bar")).toEqual(
      []
    );
  });
});
