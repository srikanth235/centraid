/*
 * TWO GESTURES ARE TWO INTENTS (#1014, C24).
 *
 * Red-first on the tree before this: the first case below returned one id for
 * both taps, because the class hashed the payload and coalesced anything
 * identical inside a two-second wall-clock window — which for "+1" is one
 * glass of water silently not logged.
 */

import { describe, expect, test } from "vitest";

import { MobileIntentIds } from "./mobile-intent-id";

describe("mobile intent ids", () => {
  test("two identical taps mint two intents", () => {
    let serial = 0;
    const ids = new MobileIntentIds(() => `u${++serial}`);
    const first = ids.forWrite();
    const second = ids.forWrite();
    expect(first).not.toBe(second);
    expect([first, second]).toStrictEqual(["1-u1", "2-u2"]);
  });

  test("the serial orders a session's ids and outlives a repeating factory", () => {
    const ids = new MobileIntentIds(() => "same");
    expect([ids.forWrite(), ids.forWrite(), ids.forWrite()]).toStrictEqual([
      "1-same",
      "2-same",
      "3-same",
    ]);
  });

  test("preserves a caller-provided cross-restart intent id", () => {
    const ids = new MobileIntentIds(() => "generated");
    expect(ids.forWrite("durable-upload")).toBe("durable-upload");
  });
});
