// `centraid-gateway trace last`: the developer's waterfall, read from the
// owner's own vault directory. No daemon, no socket, no route.

import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { TraceRecord } from "@centraid/core/protocol";
import { tempDirSync } from "@centraid/test-kit/temp-dir";

import { traceFileFor } from "../serve/trace-store.js";
import {
  commandTrace,
  renderWaterfall,
  vaultDirsByTraceRecency,
} from "./trace-admin.js";

function record(name: string, traceId = `trace-${name}`): TraceRecord {
  const root = {
    traceId,
    spanId: "root",
    hop: "gateway" as const,
    name,
    seat: "gateway" as const,
    startMs: 100,
    endMs: 112.5,
  };
  return {
    root,
    spans: [
      root,
      {
        traceId,
        spanId: "child",
        parentSpanId: "root",
        hop: "sqlite" as const,
        name: "select core_party",
        seat: "gateway" as const,
        startMs: 102,
        endMs: 109,
      },
    ],
    counters: {
      statements: 6,
      rowsScanned: 24,
      fsyncs: 1,
      bytesRead: 2100,
      bytesWritten: 198,
      workerSpawns: 0,
      httpRoundTrips: 0,
      invalidations: 0,
      reReads: 0,
    },
    journey: "cold-open",
  };
}

function seed(
  vaultDir: string,
  records: TraceRecord[],
  writtenAtSeconds?: number
): void {
  const file = traceFileFor(vaultDir);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(
    file,
    records.map((value) => `${JSON.stringify(value)}\n`).join("")
  );
  // Two files written in the same millisecond tie on mtime; the ordering this
  // command promises is only testable with explicit times.
  if (writtenAtSeconds !== undefined) {
    utimesSync(file, writtenAtSeconds, writtenAtSeconds);
  }
}

const failing = (message: string, code = 1): never => {
  throw new Error(`fail(${code}): ${message}`);
};

describe("the waterfall renderer", () => {
  it("nests by depth, offsets from the root, and names the work", () => {
    const text = renderWaterfall(record("GET /centraid/_vault/atlas"));
    expect(text).toContain("trace trace-GET /centraid/_vault/atlas");
    expect(text).toContain("journey=cold-open");
    expect(text).toMatch(
      /GET \/centraid\/_vault\/atlas\s+gateway\s+\+0\.00ms/u
    );
    // The child is indented and offset relative to the root's start.
    expect(text).toMatch(
      / {2}select core_party\s+sqlite\s+\+2\.00ms\s+7\.00ms/u
    );
    expect(text).toContain("total 12.50ms");
    expect(text).toContain("statements=6");
    // Zero counters are noise in a waterfall; they are omitted, not printed.
    expect(text).not.toContain("workerSpawns");
  });

  it("says so when an action recorded no work at all", () => {
    const empty = record("noop");
    const text = renderWaterfall({
      ...empty,
      counters: {
        ...empty.counters,
        statements: 0,
        rowsScanned: 0,
        fsyncs: 0,
        bytesRead: 0,
        bytesWritten: 0,
      },
    });
    expect(text).toContain("work  (none recorded)");
  });
});

describe("finding the last tap on this machine", () => {
  it("orders vaults by when their trace file was last written", () => {
    const root = tempDirSync("centraid-trace-cli-");
    seed(path.join(root, "vault-a"), [record("a")], 1_700_000_000);
    seed(path.join(root, "vault-b"), [record("b")], 1_700_000_060);
    const ordered = vaultDirsByTraceRecency(root);
    expect(ordered).toHaveLength(2);
    // Newest first; b was written last.
    expect(ordered[0]).toBe(path.join(root, "vault-b"));
  });

  it("ignores a vault with no traces, and a root that does not exist", () => {
    const root = tempDirSync("centraid-trace-cli-");
    mkdirSync(path.join(root, "vault-empty"), { recursive: true });
    expect(vaultDirsByTraceRecency(root)).toStrictEqual([]);
    expect(vaultDirsByTraceRecency(path.join(root, "nope"))).toStrictEqual([]);
  });
});

describe("centraid-gateway trace last", () => {
  it("prints the most recent record from an explicit vault dir", async () => {
    const dir = tempDirSync("centraid-trace-cli-");
    seed(dir, [record("first"), record("second")]);
    const out = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    let printed = "";
    try {
      await commandTrace(["last", "--vault-dir", dir], failing);
      printed = String(out.mock.calls[0]?.[0]);
    } finally {
      out.mockRestore();
    }
    expect(printed).toContain("trace trace-second");
  });

  it("--json hands back the record itself, for a rig to consume", async () => {
    const dir = tempDirSync("centraid-trace-cli-");
    seed(dir, [record("only")]);
    const out = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    let printed = "";
    try {
      await commandTrace(["last", "--vault-dir", dir, "--json"], failing);
      printed = String(out.mock.calls[0]?.[0]);
    } finally {
      out.mockRestore();
    }
    const payload = JSON.parse(printed) as {
      ok: boolean;
      record: TraceRecord;
    };
    expect(payload.ok).toBe(true);
    expect(payload.record.root.name).toBe("only");
  });

  it("--clear empties the store after printing", async () => {
    const dir = tempDirSync("centraid-trace-cli-");
    seed(dir, [record("only")]);
    const out = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    try {
      await commandTrace(["last", "--vault-dir", dir, "--clear"], failing);
      await expect(
        commandTrace(["last", "--vault-dir", dir], failing)
      ).rejects.toThrow(/no traces recorded/u);
    } finally {
      out.mockRestore();
    }
  });

  it("tells the developer how to turn spans on rather than printing nothing", async () => {
    const dir = tempDirSync("centraid-trace-cli-");
    await expect(
      commandTrace(["last", "--vault-dir", dir], failing)
    ).rejects.toThrow(/CENTRAID_TRACE=1/u);
  });

  it("refuses an unknown subcommand with a usage code", async () => {
    await expect(commandTrace(["waterfall"], failing)).rejects.toThrow(
      /fail\(2\): usage/u
    );
  });
});
