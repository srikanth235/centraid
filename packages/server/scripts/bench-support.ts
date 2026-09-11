// Shared measurement primitives for the gateway benchmarks. `bench-low-end.ts`
// (the constrained budget gate, #456/#883) and `bench-journeys.ts` (the
// replica/handler/SSE/bootstrap workload, #922 F3/B4) both read from here so a
// number means the same thing in either report.

import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

/** `--name value` and `--name=value`, in that order of precedence. */
export function argReader(args: string[]): {
  option: (name: string, fallback: string) => string;
  positiveInteger: (name: string, fallback: number) => number;
} {
  const option = (name: string, fallback: string): string => {
    const inline = args.find((arg) => arg.startsWith(`${name}=`));
    if (inline) return inline.slice(name.length + 1);
    const index = args.indexOf(name);
    const spaced = args[index + 1];
    return index >= 0 && spaced !== undefined ? spaced : fallback;
  };
  const positiveInteger = (name: string, fallback: number): number => {
    const value = Number(option(name, String(fallback)));
    if (!Number.isInteger(value) || value <= 0)
      throw new Error(`${name} must be a positive integer`);
    return value;
  };
  return { option, positiveInteger };
}

export function percentile(sorted: number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  return (
    sorted[
      Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)
    ] ?? 0
  );
}

/** p50/p99/max/mean over an unsorted sample, sorted defensively. */
export function latencySummary(samples: number[]): {
  count: number;
  p50Ms: number;
  p99Ms: number;
  maxMs: number;
  meanMs: number;
} {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    count: sorted.length,
    p50Ms: percentile(sorted, 0.5),
    p99Ms: percentile(sorted, 0.99),
    maxMs: sorted.at(-1) ?? 0,
    meanMs:
      sorted.length === 0
        ? 0
        : sorted.reduce((total, value) => total + value, 0) / sorted.length,
  };
}

export function ratePerHour(delta: number, durationMs: number): number {
  return durationMs > 0 ? (delta * 3_600_000) / durationMs : 0;
}

export async function readProcIo(): Promise<
  Record<string, number> | undefined
> {
  try {
    const text = await fs.readFile("/proc/self/io", "utf8");
    return Object.fromEntries(
      text
        .trim()
        .split("\n")
        .map((line) => {
          const [key, value] = line.split(":").map((part) => part.trim());
          return [key ?? "", Number(value)];
        })
    );
  } catch {
    return undefined;
  }
}

export function resourceCounters() {
  const usage = process.resourceUsage();
  return {
    fsWrites: usage.fsWrite,
    contextSwitches:
      usage.voluntaryContextSwitches + usage.involuntaryContextSwitches,
  };
}

function isEnoent(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

export async function directoryBytes(dir: string): Promise<number> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    // The live vault owns temporary/WAL paths that can disappear between a
    // directory walk and the next syscall. A vanished entry contributes zero
    // bytes; it must not make the performance gate flaky.
    if (isEnoent(error)) return 0;
    throw error;
  }
  const sizes = await Promise.all(
    entries.map(async (entry) => {
      const target = path.join(dir, entry.name);
      if (entry.isDirectory()) return directoryBytes(target);
      if (entry.isFile()) {
        try {
          return (await fs.stat(target)).size;
        } catch (error) {
          if (!isEnoent(error)) throw error;
        }
      }
      return 0;
    })
  );
  return sizes.reduce((total, size) => total + size, 0);
}

export function quietLogger() {
  return {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };
}

/**
 * Drop a file the strace parent can find in the trace, so a phase's syscalls
 * are bracketed exactly instead of being counted from process start.
 */
export async function markTraceEpoch(suffix: string): Promise<void> {
  const marker = process.env.CENTRAID_BENCH_TRACE_MARKER;
  if (marker) await fs.writeFile(`${marker}.${suffix}`, "");
}

/** Count fsync/fdatasync between the `<marker>.start` and `<marker>.end` opens. */
export function fsyncCallsIn(trace: string, marker: string): number {
  const lines = trace.split("\n");
  const start = lines.findIndex((line) => line.includes(`${marker}.start`));
  const end = lines.findIndex(
    (line, index) => index > start && line.includes(`${marker}.end`)
  );
  if (start < 0 || end < 0)
    throw new Error("strace workload epoch markers are missing");
  return lines.slice(start + 1, end).filter((line) => {
    // A blocking syscall can be split into `<unfinished ...>` and a later
    // `<... fsync resumed>` record. Count the resumed record exactly once;
    // ordinary one-line calls count through the opening-call form.
    if (/<\.\.\. (?:fsync|fdatasync) resumed>/u.test(line)) return true;
    return (
      /\b(?:fsync|fdatasync)\(/u.test(line) &&
      !line.includes("<unfinished ...>")
    );
  }).length;
}

export function straceAvailable() {
  return (
    process.platform === "linux" && spawnSync("which", ["strace"]).status === 0
  );
}

/** The provenance every published number carries (host, runtime, requested profile). */
export function hostRecord() {
  return {
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    cpus: os.availableParallelism(),
    totalMemoryBytes: os.totalmem(),
    requestedHardwareProfile: process.env.CENTRAID_HARDWARE_PROFILE ?? "auto",
  };
}

/**
 * `GET /_gateway/health` publishes the resolved profile only as the
 * `hardware-profile` component's detail line. Parse the two knobs a
 * benchmark's provenance depends on rather than re-deriving them from the
 * profile module, so the report states what the running gateway resolved.
 */
export function resolvedProfileFrom(health: {
  components?: { component: string; detail?: string }[];
}): {
  detail: string;
  class: string | null;
  sqliteSynchronous: string | null;
  workerPoolSize: number | null;
} {
  const detail =
    health.components?.find(
      (component) => component.component === "hardware-profile"
    )?.detail ?? "";
  const field = (name: string): string | undefined =>
    new RegExp(`${name}=([^;]+)`, "u").exec(detail)?.[1]?.trim();
  const pool = field("pool");
  return {
    detail,
    class: field("class") ?? null,
    sqliteSynchronous: field("sqlite") ?? null,
    workerPoolSize: pool === undefined ? null : Number(pool),
  };
}
