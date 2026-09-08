import { describe, expect, it } from "vitest";

import {
  diffCounters,
  TRACE_SAMPLING_OFF,
  validateTraceRecord,
  waterfall,
} from "@centraid/core/protocol";

import { LiveQueryRegistry } from "./live-query-registry.js";
import { LiveQuery } from "./live-query.js";
import { fetchReplicaBootstrap } from "./shell-transport.js";
import { ClientTraceRing, ClientTracer } from "./trace.js";
import { clientWorkCounters } from "./work-counters.js";

function steadyClock(): () => number {
  let value = 0;
  return () => {
    value += 1;
    return value;
  };
}

function tracer(sampleEvery = 1): ClientTracer {
  return new ClientTracer({
    seat: "mobile",
    policy: { enabled: true, sampleEvery },
    idFactory: () => "intent-abcdefgh",
    now: steadyClock(),
  });
}

describe("the seat tracer", () => {
  it("is off by default and allocates nothing", () => {
    const off = new ClientTracer({ seat: "web" });
    expect(off.enabled).toBe(false);
    expect(off.begin("tap")).toBeUndefined();
    off.end(off.begin("tap"));
    expect(off.ring.size).toBe(0);
  });

  it("TRACE_SAMPLING_OFF is what an unset policy resolves to", () => {
    expect(new ClientTracer({ seat: "web" }).enabled).toBe(
      TRACE_SAMPLING_OFF.enabled
    );
  });

  it("records a valid, nestable record into the ring", () => {
    const seat = tracer();
    const trace = seat.begin("open photos", { journey: "cold-open" });
    const sqlite = trace?.child("sqlite", "read timeline");
    sqlite?.end({ rows: 42 });
    seat.end(trace, { shown: true });
    const record = validateTraceRecord(seat.ring.snapshot()[0]);
    expect(record.journey).toBe("cold-open");
    expect(record.root.seat).toBe("mobile");
    expect(record.root.hop).toBe("seat");
    expect(record.root.attrs?.shown).toBe(true);
    expect(waterfall(record).map((row) => row.hop)).toStrictEqual([
      "seat",
      "sqlite",
    ]);
  });

  it("uses the intent id as the trace id for a write", () => {
    const seat = tracer();
    const trace = seat.begin("save note", { traceId: "intent-0042" });
    seat.end(trace);
    expect(seat.ring.snapshot()[0]?.root.traceId).toBe("intent-0042");
  });

  it("mints through the injected factory, never a web crypto default", () => {
    const seat = tracer();
    seat.end(seat.begin("scroll"));
    expect(seat.ring.snapshot()[0]?.root.traceId).toBe("intent-abcdefgh");
  });

  it("samples one action in N, deterministically", () => {
    const seat = tracer(3);
    for (let index = 0; index < 9; index += 1) {
      seat.end(seat.begin(`tap ${index}`));
    }
    expect(
      seat.ring.snapshot().map((record) => record.root.name)
    ).toStrictEqual(["tap 0", "tap 3", "tap 6"]);
  });
});

describe("the trace ring", () => {
  it("is bounded: the oldest record falls off the back", () => {
    const ring = new ClientTraceRing(2);
    const seat = new ClientTracer({
      seat: "mobile",
      policy: { enabled: true, sampleEvery: 1 },
      ring,
      idFactory: () => "id-000000",
      now: steadyClock(),
    });
    for (const name of ["a", "b", "c"]) seat.end(seat.begin(name));
    expect(ring.snapshot().map((record) => record.root.name)).toStrictEqual([
      "b",
      "c",
    ]);
  });

  it("drain() empties it — that is what a flush does", () => {
    const ring = new ClientTraceRing();
    const seat = new ClientTracer({
      seat: "desktop",
      policy: { enabled: true, sampleEvery: 1 },
      ring,
      now: steadyClock(),
    });
    seat.end(seat.begin("a"));
    expect(ring.drain()).toHaveLength(1);
    expect(ring.size).toBe(0);
    expect(ring.drain()).toHaveLength(0);
  });
});

describe("the seat work counters", () => {
  it("counts invalidations fired and the re-reads they actually caused", async () => {
    const registry = new LiveQueryRegistry();
    let runs = 0;
    const query = new LiveQuery(async () => {
      runs += 1;
      return {
        value: runs,
        dependencies: [{ shapeId: "photos", entity: "media.item" }],
      };
    });
    registry.track(query);
    await query;
    const before = clientWorkCounters();
    registry.invalidate([
      { shapeId: "photos", entity: "media.item", source: "overlay" },
      { shapeId: "photos", entity: "media.item", source: "overlay" },
    ]);
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 10);
    });
    const delta = diffCounters(before, clientWorkCounters());
    expect(delta.invalidations).toBe(2);
    // The re-read counter is #922's D4 reads-per-action counter: it counts
    // EXECUTIONS, and the live query coalesces two invalidations arriving
    // together into one run.
    expect(delta.reReads).toBeGreaterThanOrEqual(1);
    expect(delta.reReads).toBeLessThanOrEqual(2);
    query.dispose();
  });

  it("an invalidation a query does not match costs no re-read", async () => {
    const registry = new LiveQueryRegistry();
    const query = new LiveQuery(async () => ({
      value: 1,
      dependencies: [{ shapeId: "photos", entity: "media.item", rowId: "a" }],
    }));
    registry.track(query);
    await query;
    const before = clientWorkCounters();
    registry.invalidate([
      {
        shapeId: "photos",
        entity: "media.item",
        rowId: "b",
        source: "overlay",
      },
    ]);
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 10);
    });
    const delta = diffCounters(before, clientWorkCounters());
    expect(delta.invalidations).toBe(1);
    expect(delta.reReads).toBe(0);
    query.dispose();
  });
});

describe("the transport round-trip counter", () => {
  it("counts one round trip per call into the fetcher, injected or default", async () => {
    const before = clientWorkCounters();
    const auth = { baseUrl: "http://gateway.local", token: "t" };
    const ok = (body: unknown): Response =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    const snapshot = {
      protocolVersion: 1,
      vaultId: "v",
      schemaEpoch: "1",
      cursor: { epoch: "e", seq: 1 },
      shapes: [],
      rows: [],
    };
    await fetchReplicaBootstrap(auth, async () => ok(snapshot));
    await fetchReplicaBootstrap(auth, async () => ok(snapshot));
    expect(diffCounters(before, clientWorkCounters()).httpRoundTrips).toBe(2);
  });
});
