import { describe, expect, test } from "vitest";

import vectors from "../../../../apps/extension/spec/origin-matching-v1.json";
import {
  isLoopback,
  matchesOrigin,
  pageOrigin,
} from "./queries/origin-matching.ts";

describe("blueprint Locker origin matching uses the Companion v1 contract", () => {
  test.each(vectors.vectors)("$name", (vector) => {
    expect(
      matchesOrigin(
        {
          url: vector.stored,
          url_match_policy: vector.policy as
            | "exact-host"
            | "registrable-domain",
        },
        vector.page
      )
    ).toBe(vector.match);
  });

  test("normalizes only absolute HTTP(S) origins for reveal receipts", () => {
    expect(pageOrigin("https://example.com")).toBe("https://example.com");
    expect(pageOrigin("https://example.com/path")).toBeUndefined();
    expect(pageOrigin("ftp://example.com")).toBeUndefined();
  });

  test("the HTTP exception is restricted to real loopback addresses", () => {
    expect(isLoopback("127.1.2.3")).toBe(true);
    expect(isLoopback("127.0.0.1.evil.test")).toBe(false);
  });
});
