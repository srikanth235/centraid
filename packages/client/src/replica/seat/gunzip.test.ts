import { gzipSync, deflateRawSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import { gunzip, inflateRaw } from "./gunzip.js";

/**
 * The oracle is `node:zlib` itself: every case is compressed by the same
 * library the snapshot door compresses with (`seat-routes.ts:131`), so a case
 * that passes here is a byte sequence the phone will actually be handed.
 */
function roundTrip(bytes: Uint8Array, level?: number): Uint8Array {
  return gunzip(
    new Uint8Array(gzipSync(bytes, level === undefined ? {} : { level }))
  );
}

describe("the seat's own gzip reader", () => {
  it("reads back what the door's own gzip wrote, at every level", () => {
    // Repetitive: back-references at every distance class.
    const text = Buffer.from(
      "CREATE TABLE schedule_task(task_id TEXT PRIMARY KEY, title TEXT);".repeat(
        400
      ),
      "utf8"
    );
    for (let level = 0; level <= 9; level += 1) {
      expect(Buffer.from(roundTrip(new Uint8Array(text), level))).toStrictEqual(
        text
      );
    }
  });

  it("reads back incompressible bytes (stored blocks) and an empty artifact", () => {
    const random = new Uint8Array(70_000);
    let seed = 0x2f6e_2b1;
    for (let index = 0; index < random.length; index += 1) {
      seed = (seed * 1_103_515_245 + 12_345) >>> 0;
      random[index] = (seed >>> 16) & 0xff;
    }
    expect(Buffer.from(roundTrip(random))).toStrictEqual(Buffer.from(random));
    expect(roundTrip(new Uint8Array(0))).toHaveLength(0);
  });

  it("agrees with zlib over pseudo-random shapes, not just one file", () => {
    let seed = 7;
    const sample = (): number => {
      seed = (seed * 48_271) % 2_147_483_647;
      return seed;
    };
    for (let round = 0; round < 40; round += 1) {
      const size = sample() % 30_000;
      const alphabet = 1 + (sample() % 250);
      const bytes = new Uint8Array(size);
      for (let index = 0; index < size; index += 1) {
        bytes[index] = sample() % alphabet;
      }
      expect(Buffer.from(roundTrip(bytes))).toStrictEqual(Buffer.from(bytes));
    }
  });

  it("inflates a raw deflate stream, which is the container's whole payload", () => {
    const bytes = Buffer.from("a".repeat(5_000) + "bcbcbcbc", "utf8");
    expect(
      Buffer.from(inflateRaw(new Uint8Array(deflateRawSync(bytes))))
    ).toStrictEqual(bytes);
  });

  it("refuses bytes that are not a gzip artifact rather than returning garbage", () => {
    expect(() => gunzip(new Uint8Array([1, 2, 3, 4]))).toThrow(/not a gzip/u);
  });

  it("carries the optional header fields the container allows", () => {
    const payload = Buffer.from("seat", "utf8");
    const framed = gzipSync(payload, { level: 6 });
    // FNAME: the door does not set it, but a proxy or a re-served artifact can.
    const named = Buffer.concat([
      framed.subarray(0, 3),
      Buffer.from([0b1000]),
      framed.subarray(4, 10),
      Buffer.from("vault.db\0", "utf8"),
      framed.subarray(10),
    ]);
    expect(Buffer.from(gunzip(new Uint8Array(named)))).toStrictEqual(payload);
  });
});
