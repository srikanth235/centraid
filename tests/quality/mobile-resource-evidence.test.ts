/*
 * W8.2 mobile resource evidence ledger (#842).
 *
 * The numbers that decide whether Centraid is well-behaved on a phone —
 * battery drain per foreground hour, peak resident memory under a photo
 * import, cold start on a five-year-old Android — need a real device.
 * This repo has none, and buying one is not a thing a test can do. Those
 * lanes are `blocked-external`, and `resource-evidence.ts` makes a blocked
 * lane state its own unblock condition rather than quietly not existing.
 *
 * What IS honestly measurable here is the storage and payload footprint,
 * because the SQLite layout on a phone is the same layout as on this host.
 * Those rows are `derived` — a host proxy, never a device claim — and this
 * file is the `recomputedBy` they name: it re-measures each one against a
 * freshly seeded vault and fails when the ledger and the machine disagree
 * beyond the tolerance the row itself records. A number nobody recomputes
 * decays into a claim; this is the mechanism that stops that.
 *
 * Determinism: the fixture is the seeded year-3 generator at fixed counts
 * and the bundle clock is injected, so the measurements move only when the
 * product does.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { ensureConversationLedger } from "@centraid/server/engine";

import { AnomalyLedger } from "../../packages/server/src/serve/anomaly-ledger.js";
import {
  REQUIRED_RESOURCE_LANES,
  validateResourceLedger,
  withinTolerance,
} from "../../packages/server/src/serve/resource-evidence.js";
import type {
  ResourceLedger,
  ResourceMetric,
} from "../../packages/server/src/serve/resource-evidence.js";
import { collectSupportBundleInput } from "../../packages/server/src/serve/support-bundle-source.js";
import { renderSupportBundle } from "../../packages/server/src/serve/support-bundle.js";
import { GatewayLogStore } from "../../packages/server/src/serve/gateway-log-store.js";
import { HealthRegistry } from "../../packages/server/src/serve/health-registry.js";
import { openVaultPlane } from "../../packages/server/src/serve/vault-plane.js";
import { tempDir } from "../../packages/test-kit/src/temp-dir.js";
import { seedYear3Vault } from "../../packages/test-kit/src/year3-vault.js";

const LEDGER_PATH = "tests/mobile-resource-evidence.json";
const CLOCK = Date.parse("2026-08-21T09:00:00.000Z");
/** Fixture scale the derived rows are normalised against. */
const SEED = {
  parties: 200,
  photos: 800,
  conversations: 10,
  turnsPerConversation: 4,
} as const;

async function loadLedger(): Promise<ResourceLedger> {
  const root = path.resolve(import.meta.dirname, "../..");
  return JSON.parse(
    await readFile(path.join(root, LEDGER_PATH), "utf8")
  ) as ResourceLedger;
}

/** Re-measure the three host-proxy rows against a freshly seeded vault. */
async function measure(): Promise<Record<ResourceMetric, number>> {
  const dir = await tempDir("quality-w8-resource-");
  const plane = openVaultPlane({
    bootstrap: true,
    dir,
    ownerName: "Resource evidence owner",
    logger: {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    },
    enableWalShipper: false,
  });
  try {
    const db = plane.db;
    ensureConversationLedger(db.journal);
    seedYear3Vault(
      {
        vault: db.vault,
        journal: db.journal,
        sealCell: (_entity, _column, _rowId, plaintext) => plaintext,
      },
      SEED
    );
    const items = (
      db.vault
        .prepare("SELECT COUNT(*) AS n FROM core_content_item")
        .get() as { n: number }
    ).n;
    const pageBytes =
      (db.vault.prepare("PRAGMA page_count").get() as { page_count: number })
        .page_count *
      (db.vault.prepare("PRAGMA page_size").get() as { page_size: number })
        .page_size;
    const changes = db.vault
      .prepare("SELECT * FROM replica_change")
      .all() as unknown[];
    const anomalies = new AnomalyLedger({ now: () => CLOCK });
    anomalies.record({
      kind: "budget-exceeded",
      severity: "warn",
      code: "resource.probe.sample",
      component: "quality.resource-evidence",
      facts: { items },
    });
    const bundle = renderSupportBundle(
      await collectSupportBundleInput({
        health: new HealthRegistry({ now: () => CLOCK }),
        logs: new GatewayLogStore(),
        anomalies,
        planes: [plane],
        gateway: {
          version: "0.0.0",
          protocolVersion: 1,
          minSupportedProtocol: 1,
        },
        runtime: { platform: "linux", arch: "x64", nodeVersion: "v24.0.0" },
        generatedAtMs: CLOCK,
        salt: "resource-evidence",
      })
    );
    return {
      "vault-bytes-per-1k-items": Math.round((pageBytes / items) * 1000),
      "sync-bytes-per-pass": JSON.stringify(changes).length,
      "support-bundle-bytes": bundle.bytes,
      // Device metrics are not measurable here; the ledger carries them as
      // blocked rows and this map never claims a number for them.
      "battery-drain-pct-per-hour": Number.NaN,
      "peak-rss-mb": Number.NaN,
      "cold-start-ms": Number.NaN,
    };
  } finally {
    plane.stop();
  }
}

describe("W8.2 mobile resource evidence ledger", () => {
  test("the ledger validates: every lane is measured or blocked with an unblock condition", async () => {
    const result = validateResourceLedger(await loadLedger());
    expect(result.errors).toStrictEqual([]);
    expect(result.blocked.length).toBeGreaterThan(0);
    expect(result.recorded.length).toBeGreaterThan(0);
  });

  test("every required lane is present and every blocked lane is loud", async () => {
    const ledger = await loadLedger();
    const lanes = new Set(
      ledger.observations.map((row) => `${row.surface}/${row.metric}`)
    );
    for (const [surface, metric] of REQUIRED_RESOURCE_LANES)
      expect(lanes, `${surface}/${metric}`).toContain(`${surface}/${metric}`);
    for (const row of ledger.observations)
      if (row.method === "blocked-external") {
        // A blocked row is a citation, not a shrug: it names what is missing
        // and the exact condition that would produce the number.
        expect(row.blockedReason?.length ?? 0).toBeGreaterThan(20);
        expect(row.unblockCondition?.length ?? 0).toBeGreaterThan(20);
        expect(row.value).toBeNull();
      }
  });

  test("every derived row still reproduces on this machine", async () => {
    const ledger = await loadLedger();
    const observed = await measure();
    const derivedRows = ledger.observations.filter(
      (row) => row.method === "derived"
    );
    expect(derivedRows.length).toBeGreaterThanOrEqual(3);
    for (const row of derivedRows) {
      const now = observed[row.metric];
      expect(Number.isFinite(now), `${row.id} has no recomputation`).toBe(true);
      expect(
        withinTolerance(row, now),
        `${row.id}: ledger ${row.value} ±${(row.tolerance ?? 0) * 100}% but measured ${now}`
      ).toBe(true);
    }
  });

  test("PROBE", async () => {
    // eslint-disable-next-line no-console
    console.log("MEASURED", JSON.stringify(await measure()));
    expect(1).toBe(1);
  });

  test("the derived rows point at this file as their recomputation", async () => {
    const ledger = await loadLedger();
    for (const row of ledger.observations)
      if (row.method === "derived")
        expect(row.recomputedBy).toBe(
          "tests/quality/mobile-resource-evidence.test.ts"
        );
  });
});
