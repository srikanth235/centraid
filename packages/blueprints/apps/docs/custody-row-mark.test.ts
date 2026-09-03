// @vitest-environment jsdom
import { describe, expect, test } from "vitest";

import { custodyMeta, custodyRowMark } from "./format.ts";

describe("docs custodyRowMark", () => {
  test("marks local-only — the one state a member can lose something to", () => {
    expect(custodyRowMark("local-only")).toStrictEqual({
      label: "On this device only",
      tone: "warn",
    });
  });

  test("marks missing — a genuine integrity failure, not the steady state", () => {
    expect(custodyRowMark("missing")).toStrictEqual({
      label: "Missing — needs attention",
      tone: "danger",
    });
  });

  test.each(["replicated", "remote-only"])(
    "says nothing for the steady state %s",
    (state) => {
      expect(custodyRowMark(state)).toBeNull();
    }
  );

  test("says nothing for the transient pending-offsite window", () => {
    expect(custodyRowMark("pending-offsite")).toBeNull();
  });

  test("says nothing for a custody-less row", () => {
    expect(custodyRowMark(null)).toBeNull();
    expect(custodyRowMark(undefined)).toBeNull();
  });

  test("the per-item full story still carries all four states", () => {
    expect(custodyMeta("replicated")).toStrictEqual({
      label: "Backed up",
      tone: "ok",
    });
    expect(custodyMeta("remote-only")).toStrictEqual({
      label: "Only in the cloud",
      tone: "warn",
    });
  });
});
