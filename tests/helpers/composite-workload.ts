import { readdir, stat } from "node:fs/promises";
import path from "node:path";

import { tempDir } from "@centraid/test-kit/temp-dir";

import { serve } from "../../packages/server/src/serve/serve.js";
import type { GatewayServeHandle } from "../../packages/server/src/serve/serve.js";

export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

export function seededBytes(
  seed: number,
  size: number
): Uint8Array<ArrayBuffer> {
  let state = (seed * 2_654_435_761) >>> 0;
  const buffer = new ArrayBuffer(size);
  const view = new DataView(buffer);
  for (let offset = 0; offset + 4 <= size; offset += 4) {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    view.setUint32(offset, state, true);
  }
  return new Uint8Array(buffer);
}

export function percentile(
  samples: readonly number[],
  fraction: number
): number {
  if (samples.length === 0) return Number.NaN;
  const sorted = [...samples].sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(fraction * sorted.length) - 1)
  );
  return sorted[index]!;
}

export function median(samples: readonly number[]): number {
  if (samples.length === 0) return Number.NaN;
  const sorted = [...samples].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]!
    : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

export interface CompositeGateway {
  readonly url: string;
  readonly token: string;
  readonly dataDir: string;
  readonly vaultDir: string;
  readonly handle: GatewayServeHandle;
  close: () => Promise<void>;
}

export async function bootCompositeGateway(
  prefix: string
): Promise<CompositeGateway> {
  const dataDir = await tempDir(prefix);
  const vaultDir = path.join(dataDir, "vault");
  const token = `${prefix}token`;
  const handle = await serve({ paths: { vaultDir }, token });
  return {
    url: handle.url,
    token,
    dataDir,
    vaultDir,
    handle,
    close: () => handle.close(),
  };
}

export interface OpOutcome {
  status: number;
  code: string | null;
  durationMs: number;
  transportError: string | null;
}

export interface LaneResult {
  lane: string;
  ops: number;
  ok: number;
  refusals: Record<string, number>;
  transportErrors: string[];
  latencyMs: number[];
}

function emptyLane(lane: string): LaneResult {
  return {
    lane,
    ops: 0,
    ok: 0,
    refusals: {},
    transportErrors: [],
    latencyMs: [],
  };
}

function record(result: LaneResult, outcome: OpOutcome): void {
  result.ops += 1;
  result.latencyMs.push(outcome.durationMs);
  if (outcome.transportError !== null) {
    result.transportErrors.push(outcome.transportError);
    return;
  }
  if (outcome.status >= 200 && outcome.status < 300) {
    result.ok += 1;
    return;
  }
  const key = `${outcome.status}/${outcome.code ?? "untyped"}`;
  result.refusals[key] = (result.refusals[key] ?? 0) + 1;
}

export async function callOnce(
  gateway: CompositeGateway,
  pathname: string,
  init?: { method?: string; body?: BodyInit; contentType?: string }
): Promise<OpOutcome> {
  const started = performance.now();
  try {
    const response = await fetch(`${gateway.url}${pathname}`, {
      method: init?.method ?? "GET",
      headers: {
        authorization: `Bearer ${gateway.token}`,
        ...(init?.contentType ? { "content-type": init.contentType } : {}),
      },
      ...(init?.body === undefined ? {} : { body: init.body }),
    });
    const text = await response.text();
    const durationMs = performance.now() - started;
    if (response.status >= 200 && response.status < 300)
      return {
        status: response.status,
        code: null,
        durationMs,
        transportError: null,
      };
    let code: string | null = null;
    try {
      const parsed = JSON.parse(text) as { error?: unknown; code?: unknown };
      const named = parsed.code ?? parsed.error;
      code = typeof named === "string" ? named : null;
    } catch {
      code = null;
    }
    return { status: response.status, code, durationMs, transportError: null };
  } catch (error) {
    return {
      status: 0,
      code: null,
      durationMs: performance.now() - started,
      transportError: error instanceof Error ? error.message : String(error),
    };
  }
}

async function drive(
  lane: string,
  ops: number,
  concurrency: number,
  operation: (index: number) => Promise<OpOutcome>
): Promise<LaneResult> {
  const result = emptyLane(lane);
  let next = 0;
  const workers = Array.from(
    { length: Math.max(1, Math.min(concurrency, ops)) },
    async () => {
      for (let index = next++; index < ops; index = next++) {
        // oxlint-disable-next-line no-await-in-loop
        record(result, await operation(index));
      }
    }
  );
  await Promise.all(workers);
  return result;
}

export async function syncLane(
  gateway: CompositeGateway,
  ops: number,
  concurrency = 2
): Promise<LaneResult> {
  return drive("sync", ops, concurrency, async (index) =>
    callOnce(
      gateway,
      `/centraid/_vault/replica/bootstrap?window=${50 + (index % 5) * 25}`
    )
  );
}

export async function searchLane(
  gateway: CompositeGateway,
  ops: number,
  seed: number,
  concurrency = 2
): Promise<LaneResult> {
  const rng = mulberry32(seed);
  const terms = Array.from(
    { length: ops },
    () => `soak${Math.floor(rng() * 64)}`
  );
  return drive("search", ops, concurrency, async (index) =>
    callOnce(gateway, "/centraid/notes/queries/search", {
      method: "POST",
      contentType: "application/json",
      body: JSON.stringify({ input: { term: terms[index]! } }),
    })
  );
}

export async function writeLane(
  gateway: CompositeGateway,
  ops: number,
  seed: number,
  concurrency = 2
): Promise<LaneResult> {
  const rng = mulberry32(seed);
  const bodies = Array.from(
    { length: ops },
    (_, index) =>
      `soak${Math.floor(rng() * 64)} body ${index} ${Math.floor(rng() * 1e9)}`
  );
  return drive("write", ops, concurrency, async (index) =>
    callOnce(gateway, "/centraid/notes/actions/create-note", {
      method: "POST",
      contentType: "application/json",
      body: JSON.stringify({
        input: {
          title: `Soak note ${seed}-${index}`,
          body_text: bodies[index]!,
        },
      }),
    })
  );
}

export async function blobLane(
  gateway: CompositeGateway,
  ops: number,
  seed: number,
  bytesPerOp = 64 * 1024,
  concurrency = 2
): Promise<LaneResult> {
  return drive("blob", ops, concurrency, async (index) =>
    callOnce(
      gateway,
      `/centraid/_vault/blobs?filename=soak-${seed}-${index}.bin&media_type=application/octet-stream`,
      {
        method: "POST",
        contentType: "application/octet-stream",
        body: seededBytes(seed * 1_000_003 + index, bytesPerOp),
      }
    )
  );
}

export async function browseLane(
  gateway: CompositeGateway,
  ops: number,
  seed: number,
  concurrency = 2
): Promise<LaneResult> {
  const rng = mulberry32(seed);
  const queries = Array.from({ length: ops }, () =>
    String.fromCharCode(97 + Math.floor(rng() * 26))
  );
  return drive("browse", ops, concurrency, async (index) =>
    callOnce(
      gateway,
      `/centraid/_vault/atlas/browse/ref-search?table=core.party&query=${queries[index]!}`
    )
  );
}

export interface SoakSample {
  cycle: number;
  elapsedMs: number;
  cycleMs: number;
  rssBytes: number;
  heapUsedBytes: number;
  externalBytes: number;
  arrayBufferBytes: number;
  openDescriptors: number | null;
  dbBytes: number;
  ok: number;
  refused: number;
}

export async function openDescriptorCount(): Promise<number | null> {
  try {
    return (await readdir("/proc/self/fd")).length;
  } catch {
    return null;
  }
}

export async function gatewayDbBytes(dataDir: string): Promise<number> {
  const files: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        // oxlint-disable-next-line no-await-in-loop
        await walk(full);
      } else if (/\.db(?:-wal|-shm)?$/u.test(entry.name)) {
        files.push(full);
      }
    }
  }
  await walk(dataDir);
  const sizes = await Promise.all(
    files.map(async (file) => (await stat(file).catch(() => null))?.size ?? 0)
  );
  return sizes.reduce((total, size) => total + size, 0);
}

export function slopePerSample(values: readonly number[]): number {
  const n = values.length;
  if (n < 2) return 0;
  const meanIndex = (n - 1) / 2;
  const meanValue = values.reduce((total, value) => total + value, 0) / n;
  let covariance = 0;
  let variance = 0;
  for (const [index, value] of values.entries()) {
    covariance += (index - meanIndex) * (value - meanValue);
    variance += (index - meanIndex) ** 2;
  }
  return variance === 0 ? 0 : covariance / variance;
}

export function mergeLanes(results: readonly LaneResult[]): {
  ops: number;
  ok: number;
  refusals: Record<string, number>;
  transportErrors: string[];
} {
  const refusals: Record<string, number> = {};
  const transportErrors: string[] = [];
  let ops = 0;
  let ok = 0;
  for (const result of results) {
    ops += result.ops;
    ok += result.ok;
    transportErrors.push(...result.transportErrors);
    for (const [key, count] of Object.entries(result.refusals))
      refusals[key] = (refusals[key] ?? 0) + count;
  }
  return { ops, ok, refusals, transportErrors };
}
