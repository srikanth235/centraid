import { describe, expect, it } from "vitest";

import { applyAgentCaptureKind, classifyCapture } from "./capture";

const NOW = new Date("2026-07-29T06:30:00.000Z");

describe("universal capture routing", () => {
  it.each([
    ["Remind me to call Priya", "task"],
    ["Spent ₹12.50 on lunch", "expense"],
    ["Schedule meeting tomorrow at 9am", "event"],
    ["https://example.com useful reference", "note"],
  ] as const)("routes %s to %s without a model", (text, kind) => {
    expect(classifyCapture(text, NOW)).toMatchObject({
      kind,
      confidence: "deterministic",
    });
  });

  it("parses money and calendar-relative time into reviewable fields", () => {
    expect(classifyCapture("Paid $10.25 for lunch", NOW)).toMatchObject({
      amountMinor: 1025,
      currency: "USD",
    });
    const startsAt = new Date(
      classifyCapture("Schedule call tomorrow at 9am", NOW).startsAt ?? ""
    );
    expect({
      date: startsAt.getDate(),
      hours: startsAt.getHours(),
      minutes: startsAt.getMinutes(),
      month: startsAt.getMonth(),
      year: startsAt.getFullYear(),
    }).toStrictEqual({
      date: 30,
      hours: 9,
      minutes: 0,
      month: 6,
      year: 2026,
    });
  });

  it("keeps ambiguous text uncommitted until review or agent fallback", () => {
    const preview = classifyCapture("Maybe discuss the launch", NOW);
    expect(preview.confidence).toBe("needs-review");
    expect(applyAgentCaptureKind(preview, { kind: "task" })).toMatchObject({
      kind: "task",
      confidence: "agent",
    });
    expect(applyAgentCaptureKind(preview, { kind: "secret" })).toStrictEqual(
      preview
    );
  });
});
