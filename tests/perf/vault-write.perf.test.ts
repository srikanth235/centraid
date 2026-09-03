import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { recordQualityResult } from "@centraid/test-kit/quality-result";
import { tempDir } from "@centraid/test-kit/temp-dir";

import { createTestVault } from "../helpers/factories.js";
import { rigDriftBudgetMs } from "../helpers/rig-budgets.js";

const OWNER = "tests/perf/vault-write.perf.test.ts";

const LATENCY_BUDGET_MS = 6;
const FSYNC_BUDGET = 3;
const FSYNC_TRACE_WRITES = 500;

describe("vault-write.perf", () => {
  test("journalled vault writes stay within the nightly latency and fsync budget", async () => {
    const db = await createTestVault();
    const statement = db.vault.prepare(
      `INSERT INTO core_party
       (party_id, kind, display_name, created_at, updated_at)
     VALUES (?, 'person', ?, ?, ?)`
    );
    const samples: number[] = [];
    for (let index = 0; index < 250; index += 1) {
      const started = performance.now();
      db.vault.exec("BEGIN IMMEDIATE");
      statement.run(`perf-${index}`, `Perf party ${index}`, index, index);
      db.vault.exec("COMMIT");
      samples.push(performance.now() - started);
    }
    samples.sort((left, right) => left - right);
    const p95Ms =
      samples[Math.floor(samples.length * 0.95)] ?? Number.POSITIVE_INFINITY;

    const fsyncsPerWrite = await traceFsyncsPerWrite();
    const drift = await rigDriftBudgetMs("perf", OWNER);
    const passed =
      p95Ms < LATENCY_BUDGET_MS &&
      (fsyncsPerWrite === undefined || fsyncsPerWrite <= FSYNC_BUDGET);
    const withinDrift = drift === null || p95Ms <= drift;
    await recordQualityResult({
      lane: "perf",
      owner: OWNER,
      name: "Vault write p95 and fsync budget",
      status: passed && withinDrift ? "passed" : "failed",
      measurements: [
        {
          name: "p95 transaction latency",
          value: p95Ms,
          unit: "ms",
          budget: LATENCY_BUDGET_MS,
        },
        ...(fsyncsPerWrite === undefined
          ? []
          : [
              {
                name: "fsyncs per write",
                value: fsyncsPerWrite,
                unit: "calls/write",
                budget: FSYNC_BUDGET,
              },
            ]),
      ],
    });
    expect(
      withinDrift,
      `sustained drift: ${p95Ms} vs drift budget ${drift} (1.5x the trailing median of the last 30 nightly samples)`
    ).toBe(true);
    expect(p95Ms).toBeLessThan(LATENCY_BUDGET_MS);
    expect(fsyncsPerWrite === undefined || fsyncsPerWrite <= FSYNC_BUDGET).toBe(
      true
    );
  });
});

async function traceFsyncsPerWrite(): Promise<number | undefined> {
  const straceAvailable =
    process.platform === "linux" &&
    spawnSync("strace", ["--version"], { stdio: "ignore" }).status === 0;
  if (!straceAvailable) {
    if (process.env.CI && process.platform === "linux") {
      throw new Error(
        `${OWNER}: strace is required to measure vault fsyncs/write in Linux CI ` +
          `but is unavailable; refusing to skip the fsync gate into a false green.`
      );
    }
    return undefined;
  }
  const directory = await tempDir("vault-fsync-perf-");
  const tracePath = path.join(directory, "fsync.trace");
  const vaultDir = path.join(directory, "vault");
  const child = path.resolve("tests/perf/fixtures/vault-write-child.mjs");
  const result = spawnSync(
    "strace",
    [
      "-qq",
      "-f",
      "-e",
      "trace=fsync,fdatasync",
      "-o",
      tracePath,
      process.execPath,
      child,
      vaultDir,
      String(FSYNC_TRACE_WRITES),
    ],
    { encoding: "utf8" }
  );
  if (result.status !== 0) {
    throw new Error(
      `strace fsync probe failed: ${result.stderr || result.stdout}`
    );
  }
  const trace = await readFile(tracePath, "utf8");
  const syncs = trace.match(/\b(?:fsync|fdatasync)\(/gu)?.length ?? 0;
  return syncs / FSYNC_TRACE_WRITES;
}
