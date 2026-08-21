import { describe, expect, it } from "vitest";

import { manualShareSelection } from "./named-circle-selection.ts";

describe("manual edits detach a named circle", () => {
  it("clears named reuse when a person is added or removed", () => {
    expect(
      manualShareSelection({ asha: "read" }, "ben", "read+write")
    ).toStrictEqual({
      circleId: "",
      selections: { asha: "read", ben: "read+write" },
    });
    expect(manualShareSelection({ asha: "read" }, "asha")).toStrictEqual({
      circleId: "",
      selections: {},
    });
  });

  it("clears named reuse when one person's capability changes", () => {
    expect(
      manualShareSelection({ asha: "read" }, "asha", "read+write")
    ).toStrictEqual({
      circleId: "",
      selections: { asha: "read+write" },
    });
  });
});
