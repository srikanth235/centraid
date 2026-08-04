import { describe, expect, test } from "vitest";

import { motionDuration } from "./reduced-motion";

describe("native reduced-motion adapter", () => {
  test("collapses animated durations when the platform asks for less motion", () => {
    expect(motionDuration(200, true)).toBe(0);
    expect(motionDuration(200, false)).toBe(200);
  });
});
