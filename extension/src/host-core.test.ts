import { describe, expect, it } from "vitest";

import {
  CONNECT_FAILURE_MARKER,
  frameNativeMessage,
  HOST_NAME,
  isConnectFailure,
  isDeviceRevoked,
  KNOWN_CODES,
  memberSentence,
  readNativeMessage,
  REVOKED_MARKER,
  shouldRetry,
} from "./host-core.js";

describe("retry classification, carried from v0", () => {
  const revoked = new Error(`the host refused: ${REVOKED_MARKER}`);
  const disconnected = new Error(CONNECT_FAILURE_MARKER);
  const other = new Error(
    "the app answered with a shape this build cannot read"
  );

  it("never retries a revoked device, whatever the method or the attempt", () => {
    for (const method of ["read", "capture", "ping"]) {
      expect(
        shouldRetry({ attempt: 1, maxAttempts: 5, method, error: revoked })
      ).toBe(false);
    }
  });

  it("stops at the attempt ceiling", () => {
    expect(
      shouldRetry({
        attempt: 3,
        maxAttempts: 3,
        method: "read",
        error: disconnected,
      })
    ).toBe(false);
    expect(
      shouldRetry({
        attempt: 2,
        maxAttempts: 3,
        method: "read",
        error: disconnected,
      })
    ).toBe(true);
  });

  it("retries an idempotent verb on any failure", () => {
    expect(
      shouldRetry({ attempt: 1, maxAttempts: 3, method: "read", error: other })
    ).toBe(true);
    expect(
      shouldRetry({ attempt: 1, maxAttempts: 3, method: "PING", error: other })
    ).toBe(true);
  });

  /**
   * THE RULE THAT MATTERS: a write that reached the app and then failed may
   * have been taken, so it is only retried when the connection provably never
   * happened.
   */
  it("retries a write only on a clear connect failure", () => {
    expect(
      shouldRetry({
        attempt: 1,
        maxAttempts: 3,
        method: "capture",
        error: other,
      })
    ).toBe(false);
    expect(
      shouldRetry({
        attempt: 1,
        maxAttempts: 3,
        method: "capture",
        error: disconnected,
      })
    ).toBe(true);
  });

  it("classifies by marker, and a non-Error is stringified rather than dropped", () => {
    expect(isConnectFailure(disconnected)).toBe(true);
    expect(isConnectFailure(CONNECT_FAILURE_MARKER)).toBe(true);
    expect(isConnectFailure(other)).toBe(false);
    expect(isDeviceRevoked(revoked)).toBe(true);
    expect(isDeviceRevoked(other)).toBe(false);
  });
});

describe("the member sentences", () => {
  it("gives every known code its own words, and none of them is a stack", () => {
    const seen = new Set<string>();
    for (const code of KNOWN_CODES) {
      const sentence = memberSentence(code);
      expect(sentence).not.toBe("");
      expect(sentence).not.toContain(code);
      seen.add(sentence);
    }
    // The three token codes share one sentence on purpose — the member's next
    // action is the same — so the count is four, not six.
    expect(seen.size).toBe(4);
  });

  it("has a fallback that still tells the member what to do", () => {
    expect(memberSentence("something-new")).toContain("Open the app");
  });
});

describe("the browser's framing", () => {
  it("round-trips in the host's byte order", () => {
    for (const littleEndian of [true, false]) {
      const framed = frameNativeMessage({ t: "ping" }, littleEndian);
      const read = readNativeMessage(framed, littleEndian);
      expect(read?.message).toStrictEqual({ t: "ping" });
      expect(read?.consumed).toBe(framed.length);
    }
  });

  it("is NOT the product's own u32BE framing, and the difference is visible", () => {
    const little = frameNativeMessage({ t: "ping" }, true);
    const big = frameNativeMessage({ t: "ping" }, false);
    expect(Array.from(little.subarray(0, 4))).not.toStrictEqual(
      Array.from(big.subarray(0, 4))
    );
    // Reading little-endian bytes as big-endian gives a length nothing will
    // ever satisfy, which is exactly how a mis-framed host looks: silent.
    expect(readNativeMessage(little, false)).toBeUndefined();
  });

  it("waits for a whole frame rather than parsing a partial one", () => {
    const framed = frameNativeMessage({ t: "ping" }, true);
    expect(readNativeMessage(framed.subarray(0, 3), true)).toBeUndefined();
    expect(
      readNativeMessage(framed.subarray(0, framed.length - 1), true)
    ).toBeUndefined();
  });

  it("names the host the app's own installer writes", () => {
    expect(HOST_NAME).toBe("dev.centraid.host");
  });
});
