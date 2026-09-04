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
import { journeyCeiling } from "../helpers/journeys.js";
import { rigDriftBudgetMs } from "../helpers/rig-budgets.js";

/**
 * GATEWAY REQUEST LATENCY AT VOLUME (issue #883 C1).
 *
 * `tests/perf/gateway-request.perf.test.ts` measures the same core routes
 * against an EMPTY vault in a forked child. Its budget entries said so, and
 * tests/journeys.json is blunt about what that buys: "a budget
 * measured on an empty vault is a bundle/transport ratchet only and cannot
 * catch an O(vault-size) regression". Two of gateway.json's most-quoted
 * numbers — `requestToFirstByte` and `coreRouteP95Ms` — were in exactly that
 * state.
 *
 * This is the volume half. It seeds a bounded year-3 approximation through the
 * SHARED fixture generator (`seedYear3Vault`, the same one the quality lane
 * uses) and then measures:
 *
 *   - the three core routes' p95, gated against `coreRouteP95Ms`;
 *   - a windowed replica bootstrap page, which unlike the core routes DOES
 *     read domain rows — published as the witness that the vault really is
 *     big, not gated, because its cost is a function of the page size the
 *     caller asks for;
 *   - cold start on the SEEDED vault directory, gated against
 *     `gatewayColdStartMs`. The empty-vault lane forks a child and measures
 *     the same key; this one answers the question that key exists for — does
 *     a full vault make the gateway slower to open?
 *
 * The gateway runs IN THIS PROCESS rather than in a forked child, because the
 * seed has to reach the vault the gateway serves. That makes the absolute
 * numbers a floor relative to the forked-child lane (no IPC, warm module
 * graph), which is why this rig gates the same ceilings rather than tightening
 * them on its own evidence.
 */
const OWNER = "tests/perf/gateway-request-volume.perf.test.ts";
const CORE_ROUTES = {
  gatewayInfo: "/centraid/_gateway/info",
  apps: "/centraid/_apps",
  health: "/centraid/_gateway/health",
} as const;
/** Samples per route. Serial: this is a latency measurement, not a load test. */
const SAMPLES = 30;
/** Rows the seeded vault carries. See the `volume` string in gateway.json. */
const SEED_COUNTS = {
  parties: 5_000,
  photos: 10_000,
  conversations: 200,
  turnsPerConversation: 12,
} as const;

function percentile(samples: readonly number[], fraction: number): number {
  const sorted = [...samples].sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(fraction * sorted.length) - 1)
  );
  return sorted[index] ?? Number.NaN;
}

/** p95 of `SAMPLES` serial GETs of one route. */
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
    /** The p95 ceiling for one core route; throws rather than defaulting. */
    const routeCeilingMs = (identity: string): number =>
      journeyCeiling(
        "gateway/core-route/year3/ci-linux-x64-4c",
        "coreRouteP95Ms",
        identity
      );
    const coldStartCeilingMs = journeyCeiling(
      "gateway/cold-open/year3/ci-linux-x64-4c",
      "gatewayColdStartMs",
      "ceilingMs"
    );
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
    // The conversation ledger lives in the journal DB and is created lazily by
    // the conversation store; the fixture writes turns straight into it.
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
    // The witness lane: a windowed bootstrap page reads real rows out of the
    // seeded vault, so a genuinely empty vault could not produce this number.
    const bootstrapP95Ms = await routeP95(
      handle,
      "/centraid/_vault/replica/bootstrap?window=200",
      token
    );

    // Cold start on the SEEDED directory: close the gateway and reopen the
    // same vault from disk.
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
      ...Object.keys(CORE_ROUTES).map(routeCeilingMs)
    );
    const routesPassed = Object.entries(routeP95s).every(
      ([identity, value]) => value < routeCeilingMs(identity)
    );
    const coldPassed = coldStartMs < coldStartCeilingMs;
    // #659 R4 — sustained-drift gate over this rig's own 30-sample nightly
    // history. Null until the history is deep enough; a null is "no opinion
    // yet", never a pass.
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
          budget: routeCeilingMs(identity),
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
          budget: coldStartCeilingMs,
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
    expect(coldStartMs).toBeLessThan(coldStartCeilingMs);
  });
});
