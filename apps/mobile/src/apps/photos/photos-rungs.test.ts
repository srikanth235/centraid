import { describe, expect, test } from "vitest";

import {
  DEFAULT_RUNG,
  PINCH_IN_THRESHOLD,
  PINCH_OUT_THRESHOLD,
  RUNGS,
  RUNG_LABELS,
  pinchRung,
  rungHeight,
  stepRung,
} from "./photos-rungs";

describe("tile size on the phone (handoff §4.2, CHANGELOG §D)", () => {
  test("all four rungs survive on the phone", () => {
    expect(RUNG_LABELS).toStrictEqual(["XS", "S", "M", "L"]);
    expect(RUNGS).toHaveLength(4);
    expect(RUNGS.every((rung) => rung.phone > 0)).toBe(true);
  });

  test("the phone targets are the handoff's numbers", () => {
    expect(
      [0, 1, 2, 3].map((r) => rungHeight(r as 0 | 1 | 2 | 3, "phone"))
    ).toStrictEqual([64, 88, 120, 168]);
  });

  test("the desktop column is unchanged, so one index means one preference", () => {
    expect(
      [0, 1, 2, 3].map((r) => rungHeight(r as 0 | 1 | 2 | 3, "desktop"))
    ).toStrictEqual([92, 128, 176, 248]);
  });

  test("M is the default", () => {
    expect(DEFAULT_RUNG).toBe(2);
    expect(RUNG_LABELS[DEFAULT_RUNG]).toBe("M");
  });
});

describe("pinch does the same thing as the stepper", () => {
  test("a pinch out lands on the rung the stepper's + would", () => {
    for (const rung of [0, 1, 2, 3] as const) {
      expect(pinchRung(rung, PINCH_OUT_THRESHOLD)).toBe(stepRung(rung, 1));
    }
  });

  test("a pinch in lands on the rung the stepper's − would", () => {
    for (const rung of [0, 1, 2, 3] as const) {
      expect(pinchRung(rung, PINCH_IN_THRESHOLD)).toBe(stepRung(rung, -1));
    }
  });

  test("neither runs off the end of the table", () => {
    expect(stepRung(3, 1)).toBe(3);
    expect(pinchRung(3, 2)).toBe(3);
    expect(stepRung(0, -1)).toBe(0);
    expect(pinchRung(0, 0.2)).toBe(0);
  });

  test("an incidental two-finger drag does not change a stored preference", () => {
    expect(pinchRung(2, 1)).toBe(2);
    expect(pinchRung(2, 1.05)).toBe(2);
    expect(pinchRung(2, 0.95)).toBe(2);
  });
});
