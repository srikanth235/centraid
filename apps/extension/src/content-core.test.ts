import { describe, expect, it } from "vitest";

import {
  pageCaptureFromTab,
  randomPassword,
  unwrapCompanionEnvelope,
} from "./content-core.js";

describe(unwrapCompanionEnvelope, () => {
  it("returns value on ok envelopes and throws otherwise", () => {
    expect(unwrapCompanionEnvelope({ ok: true, value: 42 })).toBe(42);
    expect(() =>
      unwrapCompanionEnvelope({ ok: false, error: "locked" })
    ).toThrow("locked");
    expect(() => unwrapCompanionEnvelope(undefined)).toThrow(
      "Centraid request failed."
    );
  });
});

describe(randomPassword, () => {
  it("returns the requested length from the allowed alphabet", () => {
    // Deterministic stream of small values always accepted by rejection sampling.
    let n = 0;
    const pw = randomPassword(16, () => {
      const arr = new Uint32Array(4);
      for (let i = 0; i < arr.length; i++) arr[i] = n++ % 50;
      return arr;
    });
    expect(pw).toHaveLength(16);
    expect(pw).toMatch(
      /^[ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%^&*]+$/u
    );
  });

  it("rejects out-of-bound samples (unbiased charset)", () => {
    // First value is >= bound (rejected); second is 0 (accepted).
    const alphabetLen =
      "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%^&*"
        .length;
    const bound = Math.floor(0x1_0000_0000 / alphabetLen) * alphabetLen;
    let calls = 0;
    const pw = randomPassword(1, () => {
      calls += 1;
      return new Uint32Array([calls === 1 ? bound : 0]);
    });
    expect(pw).toHaveLength(1);
    expect(calls).toBe(2);
  });
});

describe(pageCaptureFromTab, () => {
  it("falls back title to url and includes selection when present", () => {
    expect(pageCaptureFromTab({ url: "https://x.test" })).toStrictEqual({
      title: "https://x.test",
      url: "https://x.test",
    });
    expect(
      pageCaptureFromTab({
        title: "Page",
        url: "https://x.test",
        selectionText: "hi",
      })
    ).toStrictEqual({ title: "Page", url: "https://x.test", selection: "hi" });
  });
});
