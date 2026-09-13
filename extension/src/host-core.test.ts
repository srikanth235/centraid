import { describe, expect, it } from "vitest";

import {
  frameNativeMessage,
  HOST_NAME,
  readNativeMessage,
} from "./host-core.js";

describe("the browser's own framing", () => {
  it("round-trips a message in either byte order", () => {
    for (const littleEndian of [true, false]) {
      const message = { t: "ping" };
      const framed = frameNativeMessage(message, littleEndian);
      const read = readNativeMessage(framed, littleEndian);
      expect(read?.message).toStrictEqual(message);
      expect(read?.consumed).toBe(framed.length);
    }
  });

  /*
   * THE TRAP THIS FILE EXISTS FOR. The product's framing is `u32BE`
   * (`crates/protocol/src/framing.rs`) and the browser's is the host platform's
   * byte order. On every machine this ships to those differ, and a host that
   * writes the wrong one is a host the browser disconnects with no error anyone
   * sees.
   */
  it("writes a length that differs between the two orders", () => {
    const little = frameNativeMessage({ t: "ping" }, true);
    const big = frameNativeMessage({ t: "ping" }, false);
    expect([...little.subarray(0, 4)]).not.toStrictEqual([
      ...big.subarray(0, 4),
    ]);
    // And reading with the wrong order does not quietly half-work.
    expect(readNativeMessage(little, false)).toBeUndefined();
  });

  it("waits for a whole frame rather than guessing", () => {
    const framed = frameNativeMessage({ t: "ping" }, true);
    expect(readNativeMessage(framed.subarray(0, 3), true)).toBeUndefined();
    expect(readNativeMessage(framed.subarray(0, 5), true)).toBeUndefined();
    expect(readNativeMessage(framed, true)).toBeDefined();
  });

  it("names the host the manifest names", () => {
    expect(HOST_NAME).toBe("dev.centraid.host");
  });
});
