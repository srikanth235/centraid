/**
 * Token precedence depth for resolveToken (issue #545 B10).
 */

import { describe, expect, test } from "vitest";

import { resolveToken } from "./auth.ts";

describe("auth.precedence", () => {
  test("whitespace-only --token falls through to env", () => {
    expect(
      resolveToken({
        token: "   ",
        env: { CENTRAID_TOKEN: "from-env", CENTRAID_GATEWAY_TOKEN: "from-gw" },
      })
    ).toBe("from-env");
  });

  test("trims --token and both env keys", () => {
    expect(
      resolveToken({ token: "  explicit  ", env: { CENTRAID_TOKEN: "e" } })
    ).toBe("explicit");
    expect(resolveToken({ env: { CENTRAID_TOKEN: "  env  " } })).toBe("env");
    expect(resolveToken({ env: { CENTRAID_GATEWAY_TOKEN: "  gw  " } })).toBe(
      "gw"
    );
  });

  test("empty CENTRAID_TOKEN falls through to CENTRAID_GATEWAY_TOKEN", () => {
    expect(
      resolveToken({
        env: { CENTRAID_TOKEN: "", CENTRAID_GATEWAY_TOKEN: "gw" },
      })
    ).toBe("gw");
    expect(
      resolveToken({
        env: { CENTRAID_TOKEN: "   ", CENTRAID_GATEWAY_TOKEN: "gw" },
      })
    ).toBe("gw");
  });

  test("CENTRAID_TOKEN wins over CENTRAID_GATEWAY_TOKEN when both set", () => {
    expect(
      resolveToken({
        env: { CENTRAID_TOKEN: "env", CENTRAID_GATEWAY_TOKEN: "gw" },
      })
    ).toBe("env");
  });
});
