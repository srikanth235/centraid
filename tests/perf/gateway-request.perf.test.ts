import { fork } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, onTestFinished, test } from "vitest";

import { recordQualityResult } from "@centraid/test-kit/quality-result";
import { forEachSequentially } from "@centraid/test-kit/sequential";
import { tempDir } from "@centraid/test-kit/temp-dir";

import { rigDriftBudgetMs } from "../helpers/rig-budgets.js";

const OWNER = "tests/perf/gateway-request.perf.test.ts";

// --- Budgets ---------------------------------------------------------------
// Both measured 2026-07-19 (darwin arm64) against the gateway running in a
// FORKED CHILD (see gateway-idle-server.mjs), self-reporting its own CPU.
//
// Request p95 baseline ≈ 40 ms (60 GETs of /centraid/_apps). Budget = ~3× = 120.
// Idle CPU baseline ≈ 1–3 ms of CPU per second of wall-clock over a 5 s idle
// window (the 1 s idle-poll costs ~nothing). Budget = ~3× a conservative
// baseline. The OLD test measured the VITEST process over 500 ms with a 300 ms
// (60%-of-a-core) ceiling — shorter than the poll period and on the wrong
// process, so the idle-poll defect could never breach it.
const experienceBudget = JSON.parse(
  readFileSync(path.resolve("tests/experience-budgets/gateway.json"), "utf8")
) as {
  metrics: {
    coreRouteP95Ms: Record<"gatewayInfo" | "apps" | "health", number>;
    gatewayColdStartMs: { ceilingMs: number };
  };
};
const CORE_ROUTES = {
  gatewayInfo: "/centraid/_gateway/info",
  apps: "/centraid/_apps",
  health: "/centraid/_gateway/health",
} as const;
const IDLE_CPU_BUDGET_MS_PER_S = 25;
const IDLE_WINDOW_MS = 5_000;

describe("gateway-request.perf", () => {
  test("core route p95 and cold start stay within nightly rig-drift budgets", async () => {
    const root = await tempDir("gateway-perf-");
    const coldStarted = performance.now();
    const child = fork(
      path.resolve("tests/perf/fixtures/gateway-idle-server.mjs"),
      [root],
      {
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      }
    );
    let childError = "";
    child.stderr?.on("data", (chunk) => {
      childError += String(chunk);
    });
    onTestFinished(() => {
      if (child.connected) child.send({ type: "close" });
      child.kill();
    });

    const ready = await childMessage<{
      type: "ready";
      url: string;
      token: string;
    }>(child, "ready", () => childError, 20_000);
    const coldStartMs = performance.now() - coldStarted;

    const routeMeasurements: Array<readonly [string, number]> = [];
    await forEachSequentially(
      Object.entries(CORE_ROUTES),
      async ([identity, route]) => {
        const samples: number[] = [];
        // Sequential samples measure the latency an owner sees for one request;
        // concurrent bursts turn this into a throughput/queueing benchmark.
        await forEachSequentially(Array.from({ length: 30 }), async () => {
          const started = performance.now();
          const response = await fetch(`${ready.url}${route}`, {
            headers: { authorization: `Bearer ${ready.token}` },
          });
          expect(response.status).toBe(200);
          await response.arrayBuffer();
          samples.push(performance.now() - started);
        });
        samples.sort((left, right) => left - right);
        routeMeasurements.push([
          identity,
          samples[Math.floor(samples.length * 0.95)]!,
        ]);
      }
    );
    const routeP95 = Object.fromEntries(routeMeasurements) as Record<
      keyof typeof CORE_ROUTES,
      number
    >;

    child.send({ type: "measure-idle", windowMs: IDLE_WINDOW_MS });
    const idle = await childMessage<{
      type: "idle";
      cpuUserUs: number;
      cpuSystemUs: number;
      wallMs: number;
    }>(child, "idle", () => childError, IDLE_WINDOW_MS + 15_000);
    const idleCpuMs = (idle.cpuUserUs + idle.cpuSystemUs) / 1_000;
    const idleCpuMsPerSecond = idleCpuMs / (idle.wallMs / 1_000);

    // #659 R4 — sustained-drift gate over this rig's own 30-sample
    // nightly history. Null until the history is deep enough; a null is
    // "no opinion yet", never a pass.
    const drift = await rigDriftBudgetMs("perf", OWNER);
    const routePassed = Object.entries(routeP95).every(
      ([identity, value]) =>
        value <
        experienceBudget.metrics.coreRouteP95Ms[
          identity as keyof typeof CORE_ROUTES
        ]
    );
    const passed =
      routePassed &&
      coldStartMs < experienceBudget.metrics.gatewayColdStartMs.ceilingMs &&
      idleCpuMsPerSecond < IDLE_CPU_BUDGET_MS_PER_S;
    const slowestP95Ms = Math.max(...Object.values(routeP95));
    const withinDrift = drift === null || slowestP95Ms <= drift;
    await recordQualityResult({
      lane: "perf",
      owner: OWNER,
      name: "core route p95 and cold start",
      status: passed && withinDrift ? "passed" : "failed",
      measurements: [
        {
          name: "slowest core route p95",
          value: slowestP95Ms,
          unit: "ms",
          budget: Math.max(
            ...Object.values(experienceBudget.metrics.coreRouteP95Ms)
          ),
        },
        ...Object.entries(routeP95).map(([identity, value]) => ({
          name: `${identity} p95`,
          value,
          unit: "ms",
          budget:
            experienceBudget.metrics.coreRouteP95Ms[
              identity as keyof typeof CORE_ROUTES
            ],
        })),
        {
          name: "cold start",
          value: coldStartMs,
          unit: "ms",
          budget: experienceBudget.metrics.gatewayColdStartMs.ceilingMs,
        },
        {
          name: "idle CPU per second",
          value: idleCpuMsPerSecond,
          unit: "ms/s",
          budget: IDLE_CPU_BUDGET_MS_PER_S,
        },
      ],
    });
    expect(
      withinDrift,
      `sustained drift: ${slowestP95Ms} vs drift budget ${drift} (1.5x the trailing median of the last 30 nightly samples)`
    ).toBe(true);
    expect(routePassed).toBe(true);
    expect(coldStartMs).toBeLessThan(
      experienceBudget.metrics.gatewayColdStartMs.ceilingMs
    );
    expect(idleCpuMsPerSecond).toBeLessThan(IDLE_CPU_BUDGET_MS_PER_S);
  });
});

function childMessage<T>(
  child: ChildProcess,
  expectedType: string,
  stderr: () => string,
  timeoutMs: number
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(
          new Error(`gateway perf child timed out waiting for ${expectedType}`)
        ),
      timeoutMs
    );
    const onMessage = (message: unknown) => {
      if ((message as { type?: string })?.type !== expectedType) return;
      cleanup();
      resolve(message as T);
    };
    const onExit = (code: number | null) => {
      cleanup();
      reject(new Error(`gateway perf child exited ${code}: ${stderr()}`));
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.off("message", onMessage);
      child.off("exit", onExit);
    };
    child.on("message", onMessage);
    child.once("exit", onExit);
  });
}
