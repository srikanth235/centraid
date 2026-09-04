import { appendFileSync, existsSync, rmSync } from "node:fs";
import path from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import {
  TRACE_SAMPLING_OFF,
  validateTraceRecord,
  waterfall,
} from "@centraid/core/protocol";
import type { TraceRecord } from "@centraid/core/protocol";
import { tempDirSync } from "@centraid/test-kit/temp-dir";

import {
  GatewayTracer,
  processWorkCounters,
  TRACE_ID_HEADER,
  traceIdFromHeader,
  traceRequests,
  traceSamplingFromEnvironment,
} from "./gateway-trace.js";
import {
  lazyVaultTraceSink,
  TRACE_DIR_NAME,
  TRACE_FILE_NAME,
  TraceStore,
  traceFileFor,
} from "./trace-store.js";

/**
 * The two members `traceRequests` needs from a `ServerResponse`. A hand-rolled
 * emitter rather than `node:events`: the wrapper is deliberately structural so
 * it can be unit-tested without a socket.
 */
class FakeResponse {
  private readonly listeners: (() => void)[] = [];

  once(_event: "close", listener: () => void): this {
    this.listeners.push(listener);
    return this;
  }

  close(): void {
    for (const listener of this.listeners.splice(0)) listener();
  }
}

function request(url: string, headers: Record<string, unknown> = {}) {
  return { url, method: "GET", headers };
}

let root: string;

describe("trace sampling policy", () => {
  it("is OFF with no environment — the shipped default", () => {
    expect(traceSamplingFromEnvironment({} as NodeJS.ProcessEnv)).toStrictEqual(
      TRACE_SAMPLING_OFF
    );
    expect(
      traceSamplingFromEnvironment({ CENTRAID_TRACE: "0" } as NodeJS.ProcessEnv)
    ).toStrictEqual(TRACE_SAMPLING_OFF);
  });

  it("opts in on CENTRAID_TRACE=1 and honours a sample interval", () => {
    expect(
      traceSamplingFromEnvironment({
        CENTRAID_TRACE: "1",
      } as NodeJS.ProcessEnv)
    ).toStrictEqual({ enabled: true, sampleEvery: 1 });
    expect(
      traceSamplingFromEnvironment({
        CENTRAID_TRACE: "1",
        CENTRAID_TRACE_SAMPLE_EVERY: "4",
      } as NodeJS.ProcessEnv)
    ).toStrictEqual({ enabled: true, sampleEvery: 4 });
  });

  it("falls back to every action rather than throwing on a bad interval", () => {
    expect(
      traceSamplingFromEnvironment({
        CENTRAID_TRACE: "1",
        CENTRAID_TRACE_SAMPLE_EVERY: "nonsense",
      } as NodeJS.ProcessEnv)
    ).toStrictEqual({ enabled: true, sampleEvery: 1 });
  });
});

describe("the trace store is sovereign", () => {
  beforeEach(() => {
    root = tempDirSync("centraid-trace-");
  });

  it("writes inside the vault directory, so the erase ceremony purges it", () => {
    const vaultDir = path.join(root, "vault-a");
    const store = new TraceStore(vaultDir);
    store.append(record("one"));
    expect(traceFileFor(vaultDir)).toBe(
      path.join(vaultDir, TRACE_DIR_NAME, TRACE_FILE_NAME)
    );
    expect(existsSync(traceFileFor(vaultDir))).toBe(true);
    // `VaultRegistry.delete` removes the vault directory whole; nothing else
    // needs to know traces exist.
    rmSync(vaultDir, { recursive: true, force: true });
    expect(existsSync(traceFileFor(vaultDir))).toBe(false);
    expect(new TraceStore(vaultDir).last()).toBeUndefined();
  });

  it("reads back the last record and validates it", () => {
    const store = new TraceStore(root);
    store.append(record("one"));
    store.append(record("two"));
    expect(store.last()?.root.name).toBe("two");
    expect(waterfall(store.last() as TraceRecord)).toHaveLength(2);
  });

  it("skips a torn trailing line rather than failing the reader", () => {
    const store = new TraceStore(root);
    store.append(record("one"));
    // A process that died mid-append leaves half a JSON object behind.
    appendFileSync(traceFileFor(root), '{"root":{"traceId"');
    expect(store.last()?.root.name).toBe("one");
  });

  it("clear() empties the store", () => {
    const store = new TraceStore(root);
    store.append(record("one"));
    store.clear();
    expect(store.last()).toBeUndefined();
  });

  it("a store with no vault yet writes nothing", () => {
    const lazy = lazyVaultTraceSink(() => undefined);
    lazy.append(record("one"));
    expect(existsSync(path.join(root, TRACE_DIR_NAME))).toBe(false);
  });
});

describe("the trace id header", () => {
  it("accepts an id-shaped token and refuses anything else", () => {
    expect(traceIdFromHeader("018f-abc_DEF.9:1")).toBe("018f-abc_DEF.9:1");
    expect(traceIdFromHeader("")).toBeUndefined();
    expect(traceIdFromHeader("has space")).toBeUndefined();
    expect(traceIdFromHeader("a".repeat(129))).toBeUndefined();
    expect(traceIdFromHeader(["a"])).toBeUndefined();
    expect(traceIdFromHeader(undefined)).toBeUndefined();
  });
});

describe("the per-request trace wrapper", () => {
  it("records nothing at all when tracing is off", async () => {
    const appended: TraceRecord[] = [];
    const tracer = new GatewayTracer({
      sink: { append: (value) => appended.push(value) },
    });
    const handler = traceRequests(async () => true, tracer);
    const res = new FakeResponse();
    await expect(handler(request("/x"), res as never)).resolves.toBe(true);
    res.close();
    expect(appended).toStrictEqual([]);
    expect(tracer.enabled).toBe(false);
  });

  it("records one validated record per request, joined by the seat's id", async () => {
    const appended: TraceRecord[] = [];
    const tracer = new GatewayTracer({
      policy: { enabled: true, sampleEvery: 1 },
      sink: { append: (value) => appended.push(value) },
    });
    const handler = traceRequests(async () => true, tracer);
    const res = new FakeResponse();
    await handler(
      request("/centraid/_replica/intents?x=1", {
        [TRACE_ID_HEADER]: "intent-0001",
      }),
      res as never
    );
    res.close();
    expect(appended).toHaveLength(1);
    const validated = validateTraceRecord(appended[0]);
    expect(validated.root.traceId).toBe("intent-0001");
    expect(validated.root.seat).toBe("gateway");
    // The query string is not part of the span name — it can carry ids.
    expect(validated.root.name).toBe("GET /centraid/_replica/intents");
    expect(validated.spans.map((span) => span.hop)).toStrictEqual([
      "gateway",
      "handler",
    ]);
  });

  it("closes the record exactly once even if close fires twice", async () => {
    const appended: TraceRecord[] = [];
    const tracer = new GatewayTracer({
      policy: { enabled: true, sampleEvery: 1 },
      sink: { append: (value) => appended.push(value) },
    });
    const handler = traceRequests(async () => true, tracer);
    const res = new FakeResponse();
    await handler(request("/x"), res as never);
    res.close();
    res.close();
    expect(appended).toHaveLength(1);
  });

  it("records a declined request without waiting for a close that never comes", async () => {
    const appended: TraceRecord[] = [];
    const tracer = new GatewayTracer({
      policy: { enabled: true, sampleEvery: 1 },
      sink: { append: (value) => appended.push(value) },
    });
    const handler = traceRequests(async () => false, tracer);
    await expect(
      handler(request("/x"), new FakeResponse() as never)
    ).resolves.toBe(false);
    expect(appended).toHaveLength(1);
    expect(appended[0]?.root.attrs?.answered).toBe(false);
  });

  it("samples deterministically: one action in N, the same N every run", async () => {
    const appended: TraceRecord[] = [];
    const tracer = new GatewayTracer({
      policy: { enabled: true, sampleEvery: 3 },
      sink: { append: (value) => appended.push(value) },
    });
    const handler = traceRequests(async () => true, tracer);
    // Sequential on purpose: the sampler counts actions in order, so running
    // these in parallel would be measuring something else.
    await Array.from({ length: 9 }).reduce<Promise<void>>(
      async (previous, _value, index) => {
        await previous;
        const res = new FakeResponse();
        await handler(request(`/x/${index}`), res as never);
        res.close();
      },
      Promise.resolve()
    );
    expect(appended.map((value) => value.root.name)).toStrictEqual([
      "GET /x/0",
      "GET /x/3",
      "GET /x/6",
    ]);
  });

  it("still records — and rethrows — when the handler throws", async () => {
    const appended: TraceRecord[] = [];
    const tracer = new GatewayTracer({
      policy: { enabled: true, sampleEvery: 1 },
      sink: { append: (value) => appended.push(value) },
    });
    const handler = traceRequests(async () => {
      throw new Error("boom");
    }, tracer);
    await expect(
      handler(request("/x"), new FakeResponse() as never)
    ).rejects.toThrow("boom");
    expect(appended[0]?.root.attrs?.failed).toBe(true);
  });

  it("carries the work counters the request actually spent", async () => {
    const appended: TraceRecord[] = [];
    const tracer = new GatewayTracer({
      policy: { enabled: true, sampleEvery: 1 },
      sink: { append: (value) => appended.push(value) },
    });
    const before = processWorkCounters();
    const handler = traceRequests(async () => true, tracer);
    const res = new FakeResponse();
    await handler(request("/x"), res as never);
    res.close();
    expect(processWorkCounters().statements).toBeGreaterThanOrEqual(
      before.statements
    );
    expect(appended[0]?.counters.statements).toBeGreaterThanOrEqual(0);
  });
});

function record(name: string): TraceRecord {
  const rootSpan = {
    traceId: `trace-${name}`,
    spanId: "root",
    hop: "gateway" as const,
    name,
    seat: "gateway" as const,
    startMs: 0,
    endMs: 2,
  };
  return {
    root: rootSpan,
    spans: [
      rootSpan,
      {
        traceId: rootSpan.traceId,
        spanId: "child",
        parentSpanId: "root",
        hop: "sqlite" as const,
        name: "select",
        seat: "gateway" as const,
        startMs: 1,
        endMs: 2,
      },
    ],
    counters: {
      statements: 1,
      rowsScanned: 1,
      fsyncs: 0,
      bytesRead: 8,
      bytesWritten: 0,
      workerSpawns: 0,
      httpRoundTrips: 0,
      invalidations: 0,
      reReads: 0,
    },
  };
}
