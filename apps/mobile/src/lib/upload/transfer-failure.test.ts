// The queue row is member copy (#1015 R-NY-10). What this pins is that EVERY
// outcome has a sentence — there is no path that stores an exception — and
// that no sentence carries transport vocabulary.

import { describe, expect, it } from "vitest";

import { DirectTransferError } from "./gateway-client";
import {
  memberTransferFailure,
  transferFailureDetail,
} from "./transfer-failure";

const ENGINE = /gateway|daemon|replica|component|HTTP|\d{3}/iu;

describe(memberTransferFailure, () => {
  it.each([
    [401, "This phone is no longer paired with your vault"],
    [403, "This phone is no longer paired with your vault"],
    [413, "Your vault is out of space"],
    [507, "Your vault is out of space"],
    [408, "Your vault could not be reached"],
    [429, "Your vault could not be reached"],
    [500, "Your vault could not be reached"],
    [503, "Your vault could not be reached"],
    [400, "Your vault would not take this file"],
    [404, "Your vault would not take this file"],
  ])("says what a %i means to a member", (status, sentence) => {
    expect(
      memberTransferFailure(
        new DirectTransferError(
          `POST /blobs/direct refused (${status})`,
          status
        )
      )
    ).toBe(sentence);
  });

  it("takes the thrower's own sentence when it knows better than the status", () => {
    expect(
      memberTransferFailure(
        new DirectTransferError(
          "local file is 999 bytes, expected 2048",
          400,
          "This file changed on this phone, so it was not sent"
        )
      )
    ).toBe("This file changed on this phone, so it was not sent");
  });

  it("covers the phone's own refusals, which carry no status at all", () => {
    // The URL gate (`transfer-policy.ts`) throws plain Errors whose text is
    // written for a maintainer; none of it may reach a screen.
    expect(
      memberTransferFailure(
        new Error("upload origin is not the active provider")
      )
    ).toBe("This phone could not send this file");
    expect(memberTransferFailure("nothing thrown at all")).toBe(
      "This phone could not send this file"
    );
  });

  it.each([
    new DirectTransferError("x", 401),
    new DirectTransferError("x", 413),
    new DirectTransferError("x", 503),
    new DirectTransferError("x", 400),
    new Error("x"),
  ])("never says it in engine words (%s)", (error) => {
    expect(memberTransferFailure(error)).not.toMatch(ENGINE);
  });
});

describe(transferFailureDetail, () => {
  it("keeps the raw text intact for the log", () => {
    expect(
      transferFailureDetail(
        new DirectTransferError("POST /blobs/direct refused (507)", 507)
      )
    ).toBe("POST /blobs/direct refused (507)");
    expect(transferFailureDetail({ nope: true })).toBe("[object Object]");
  });
});
