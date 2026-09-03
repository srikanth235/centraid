import { promises as fs } from "node:fs";
import path from "node:path";

import { describe, expect, onTestFinished, test } from "vitest";

import { recordQualityResult } from "@centraid/test-kit/quality-result";
import { forEachSequentially } from "@centraid/test-kit/sequential";
import { tempDir } from "@centraid/test-kit/temp-dir";
import { seedYear3Vault } from "@centraid/test-kit/year3-vault";
import { sealAad, sealValue } from "@centraid/vault";

import { serve } from "../../packages/server/src/serve/serve.js";
import type { GatewayServeHandle } from "../../packages/server/src/serve/serve.js";
import { rigDriftBudgetMs } from "../helpers/rig-budgets.js";

const OWNER = "tests/perf/gateway-request-volume.perf.test.ts";
const CORE_ROUTES = {
  gatewayInfo: "/centraid/_gateway/info",
  apps: "/centraid/_apps",
  health: "/centraid/_gateway/health",
} as const;
const SAMPLES = 30;
const SEED_COUNTS = {
  parties: 5_000,
  photos: 10_000,
  conversations: 200,
  turnsPerConversation: 12,
} as const;

interface BudgetFile {
  metrics: {
    coreRouteP95Ms: Record<keyof typeof CORE_ROUTES, number>;
    gatewayColdStartMs: { ceilingMs: number };
  };
}

function percentile(samples: readonly number[], fraction: number): number {
  const sorted = [...samples].sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(fraction * sorted.length) - 1)
  );
  return sorted[index] ?? Number.NaN;
}

async function routeP95(
  handle: GatewayServeHandle,
  route: string,
  token: string
): Promise<number> {
  const samples: number[] = [];
  await forEachSequentially(Array.from({ length: SAMPLES }), async () => {
    const started = performance.now();
    const response = await fetch(`${handle.url}${route}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.status, route).toBe(200);
    await response.arrayBuffer();
    samples.push(performance.now() - started);
  });
  return percentile(samples, 0.95);
}

describe("gateway-request-volume.perf", () => {
  test("core routes and cold start hold their ceilings on a year-3-shaped vault", async () => {
    const budgets = JSON.parse(
      await fs.readFile(
        path.resolve("tests/experience-budgets/gateway.json"),
        "utf8"
      )
    ) as BudgetFile;
    const dataDir = await tempDir("gateway-volume-perf-");
    const vaultDir = path.join(dataDir, "vault");
    const token = "gateway-volume-token";
    let handle = await serve({ paths: { vaultDir }, token });
    let open = true;
    onTestFinished(async () => {
      if (open) await handle.close().catch(() => undefined);
      await fs.rm(dataDir, { recursive: true, force: true });
    });
    const plane = handle.vaults.get(handle.vaults.defaultVaultId());
    if (!plane)
      throw new Error("the auto-founded Personal vault is not mounted");

    const seedStarted = performance.now();
    seedYear3Vault(
      {
        vault: plane.db.vault,
        sealCell: (entity, column, rowId, plaintext) =>
          sealValue(
            plane.db.sealKey,
            sealAad(entity.replace(".", "_"), column, rowId),
            plaintext
          ),
      },
      SEED_COUNTS
    );
    const seedMs = performance.now() - seedStarted;
    const domainRows = (
      plane.db.vault
        .prepare(
          `SELECT (SELECT COUNT(*) FROM core_party)
                + (SELECT COUNT(*) FROM core_content_item)
                + (SELECT COUNT(*) FROM media_asset) AS rows`
        )
        .get() as { rows: number }
    ).rows;
    expect(domainRows).toBeGreaterThan(20_000);

    const routeMeasurements: Array<readonly [string, number]> = [];
    await forEachSequentially(
      Object.entries(CORE_ROUTES),
      async ([identity, route]) => {
        routeMeasurements.push([
          identity,
          await routeP95(handle, route, token),
        ]);
      }
    );
    const routeP95s = Object.fromEntries(routeMeasurements) as Record<
      keyof typeof CORE_ROUTES,
      number
    >;
    const bootstrapP95Ms = await routeP95(
      handle,
      "/centraid/_vault/replica/bootstrap?window=200",
      token
    );

    await handle.close();
    open = false;
    const coldStarted = performance.now();
    handle = await serve({ paths: { vaultDir }, token });
    open = true;
    const coldStartMs = performance.now() - coldStarted;
    const reopened = await fetch(`${handle.url}/centraid/_gateway/health`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(reopened.status).toBe(200);

    const slowestP95Ms = Math.max(...Object.values(routeP95s));
    const loosestCeilingMs = Math.max(
      ...Object.keys(CORE_ROUTES).map(
        (identity) =>
          budgets.metrics.coreRouteP95Ms[identity as keyof typeof CORE_ROUTES]
      )
    );
    const routesPassed = Object.entries(routeP95s).every(
      ([identity, value]) =>
        value <
        budgets.metrics.coreRouteP95Ms[identity as keyof typeof CORE_ROUTES]
    );
    const coldPassed =
      coldStartMs < budgets.metrics.gatewayColdStartMs.ceilingMs;
    const drift = await rigDriftBudgetMs("perf", OWNER);
    const withinDrift = drift === null || slowestP95Ms <= drift;
    await recordQualityResult({
      lane: "perf",
      owner: OWNER,
      name: "core route p95 and cold start on a year-3-shaped vault",
      status: routesPassed && coldPassed && withinDrift ? "passed" : "failed",
      measurements: [
        {
          name: "slowest core route p95",
          value: slowestP95Ms,
          unit: "ms",
          budget: loosestCeilingMs,
        },
        ...Object.entries(routeP95s).map(([identity, value]) => ({
          name: `${identity} p95`,
          value,
          unit: "ms",
          budget:
            budgets.metrics.coreRouteP95Ms[
              identity as keyof typeof CORE_ROUTES
            ],
        })),
        {
          name: "replica bootstrap page p95 (published, not gated)",
          value: bootstrapP95Ms,
          unit: "ms",
        },
        {
          name: "cold start on seeded vault",
          value: coldStartMs,
          unit: "ms",
          budget: budgets.metrics.gatewayColdStartMs.ceilingMs,
        },
        { name: "seeded domain rows", value: domainRows, unit: "rows" },
        { name: "seed", value: seedMs, unit: "ms" },
      ],
    });
    expect(
      withinDrift,
      `sustained drift: ${slowestP95Ms} vs drift budget ${drift} (1.5x the trailing median of the last 30 nightly samples)`
    ).toBe(true);
    expect(routesPassed).toBe(true);
    expect(coldStartMs).toBeLessThan(
      budgets.metrics.gatewayColdStartMs.ceilingMs
    );
  });
});
