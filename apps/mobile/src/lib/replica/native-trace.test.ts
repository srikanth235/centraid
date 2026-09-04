// The phone's trace ring and its two flush moments (#927 OQ1). The expo
// filesystem and the native storage module are mocked; what is under test is
// the ring's boundedness, the default-off policy, and that the flush drains.

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { TraceRecord } from "@centraid/core/protocol";

/* oxlint-disable max-classes-per-file -- the fake Directory and File are one expo-file-system stand-in and cannot be one class; governance: allow-no-unjustified-suppressions test double (#927) */

class FakeDirectory {
  exists = true;
  create(): void {
    /* Every test injects its own writer; the real tree is never touched. */
  }
}

class FakeFile {
  exists = false;
  create(): void {
    this.exists = true;
  }
  text(): string {
    return "";
  }
  write(): void {
    /* Never reached: the tests inject a writer. */
  }
}

vi.mock(import("expo-file-system"), () => ({
  Directory: FakeDirectory as never,
  File: FakeFile as never,
  Paths: {} as never,
}));
vi.mock(import("../../../modules/centraid-storage"), () => ({
  replicaStorageDirectoryUri: () => "file:///durable/CentraidReplica",
}));
vi.mock(import("./native-hash"), () => ({
  nativeReplicaIdFactory: () => "native-000000",
  nativeReplicaDigest: (async () => "digest") as never,
}));

const {
  flushNativeTraces,
  nativeTraceSampling,
  nativeTracer,
  resetNativeTracerForTest,
} = await import("./native-trace");

describe("the phone's sampling policy", () => {
  it("is OFF without the env flag — the shipped default", () => {
    expect(nativeTraceSampling({})).toStrictEqual({
      enabled: false,
      sampleEvery: 0,
    });
    expect(
      nativeTraceSampling({ EXPO_PUBLIC_CENTRAID_TRACE: "0" })
    ).toStrictEqual({ enabled: false, sampleEvery: 0 });
  });

  it("opts in with an interval, and shrugs off a nonsense interval", () => {
    expect(
      nativeTraceSampling({
        EXPO_PUBLIC_CENTRAID_TRACE: "1",
        EXPO_PUBLIC_CENTRAID_TRACE_SAMPLE_EVERY: "5",
      })
    ).toStrictEqual({ enabled: true, sampleEvery: 5 });
    expect(
      nativeTraceSampling({
        EXPO_PUBLIC_CENTRAID_TRACE: "1",
        EXPO_PUBLIC_CENTRAID_TRACE_SAMPLE_EVERY: "-2",
      })
    ).toStrictEqual({ enabled: true, sampleEvery: 1 });
  });
});

describe("flushing the ring", () => {
  beforeEach(() => {
    resetNativeTracerForTest({ enabled: true, sampleEvery: 1 });
  });

  it("writes nothing when nothing was recorded", async () => {
    const written: TraceRecord[][] = [];
    await expect(
      flushNativeTraces((records) => {
        written.push([...records]);
      })
    ).resolves.toBe(0);
    expect(written).toStrictEqual([]);
  });

  it("drains what the ring holds, once", async () => {
    const seat = nativeTracer();
    seat.end(seat.begin("tap"));
    seat.end(seat.begin("scroll"));
    const written: TraceRecord[][] = [];
    await expect(
      flushNativeTraces((records) => {
        written.push([...records]);
      })
    ).resolves.toBe(2);
    expect(written[0]?.map((record) => record.root.name)).toStrictEqual([
      "tap",
      "scroll",
    ]);
    // The ring is empty now: a second background pass must not rewrite them.
    await expect(
      flushNativeTraces((records) => {
        written.push([...records]);
      })
    ).resolves.toBe(0);
  });

  it("mints trace ids through the native factory, not web crypto", async () => {
    const seat = nativeTracer();
    seat.end(seat.begin("tap"));
    const written: TraceRecord[][] = [];
    await flushNativeTraces((records) => {
      written.push([...records]);
    });
    expect(written[0]?.[0]?.root.traceId).toBe("native-000000");
    expect(written[0]?.[0]?.root.seat).toBe("mobile");
  });

  it("swallows a failing write rather than failing the background pass", async () => {
    const seat = nativeTracer();
    seat.end(seat.begin("tap"));
    await expect(
      flushNativeTraces(() => {
        throw new Error("disk full");
      })
    ).resolves.toBe(0);
  });

  it("records nothing at all with the shipped default policy", async () => {
    resetNativeTracerForTest();
    const seat = nativeTracer();
    seat.end(seat.begin("tap"));
    expect(seat.ring.size).toBe(0);
    await expect(flushNativeTraces(() => undefined)).resolves.toBe(0);
  });
});
