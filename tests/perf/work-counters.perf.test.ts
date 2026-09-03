/*
 * THE PER-PR PERF GATE (#927 P2).
 *
 * It replaces a wall-clock benchmark on the merge rung, and the whole point of
 * the replacement is what this file does NOT do: it does not time anything, it
 * does not sample, it does not retry, and it reads no history. It runs a fixed
 * workload against the golden year-3 vault, takes the integers the product
 * counts about itself, and compares them to `scripts/ci/work-counters.expected.json`.
 * Two runs on the same code give the same integers on any host, so a red here
 * is a regression and never a noisy sample — which is exactly what the old
 * rig's automatic retry (#557) existed to absorb.
 *
 * Adding a statement or a durability barrier to one of these paths fails this
 * on its first run. The receipt for #927 w1-gate records both seeded
 * regressions and the exact output.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, onTestFinished, test } from "vitest";

import { diffCounters } from "@centraid/core/protocol";
import type { WorkCounters } from "@centraid/core/protocol";
import {
  createGateway,
  gatewayWorkCounters,
  openVaultDb,
  registerAtlasCommands,
} from "@centraid/vault";
import type { Credential } from "@centraid/vault";

import {
  compareAll,
  explainFailures,
  renderRows,
  verdict,
} from "../../scripts/ci/work-counter-gate.mjs";
import { goldenYear3Vault } from "../helpers/factories.js";

const EXPECTATIONS = path.resolve("scripts/ci/work-counters.expected.json");

/** The work one call cost: two snapshots of a total that only ever climbs. */
function costOf(run: () => void): WorkCounters {
  const before = gatewayWorkCounters();
  run();
  return diffCounters(before, gatewayWorkCounters());
}

describe("the per-PR work-counter gate", () => {
  test("the hot paths cost exactly what the expectations say", async () => {
    const golden = await goldenYear3Vault();
    const db = openVaultDb({ dir: golden.dir, sealKey: golden.sealKey });
    onTestFinished(() => db.close());
    const gateway = createGateway(db);
    registerAtlasCommands(gateway);
    const device = db.vault
      .prepare("SELECT device_id, public_key FROM access_device LIMIT 1")
      .get() as { device_id: string; public_key: string };
    const owner: Credential = {
      kind: "device",
      deviceId: device.device_id,
      deviceKey: device.public_key,
    };

    // WARM FIRST. The first call through any path compiles statements and
    // fills SQLite's page cache; measuring that would be measuring the
    // fixture's coldness, and it is not what a regression moves.
    gateway.read(owner, { entity: "core.party", limit: 20 });
    gateway.invoke(owner, {
      command: "atlas.insert_row",
      input: {
        table: "core.place",
        values: { name: "counter gate warmup", kind: "venue" },
      },
    });

    const measurements: Record<string, WorkCounters> = {
      "gateway.read core.party limit=20": costOf(() => {
        gateway.read(owner, { entity: "core.party", limit: 20 });
      }),
      "gateway.invoke atlas.insert_row core.place": costOf(() => {
        gateway.invoke(owner, {
          command: "atlas.insert_row",
          input: {
            table: "core.place",
            values: { name: "counter gate measured", kind: "venue" },
          },
        });
      }),
    };

    if (process.env.CENTRAID_WORK_COUNTER_CAPTURE) {
      process.stdout.write(`CAPTURE ${JSON.stringify(measurements)}\n`);
    }
    const expectations = JSON.parse(readFileSync(EXPECTATIONS, "utf8"));
    const rows = compareAll(expectations, measurements);
    process.stdout.write(`${renderRows(rows)}\n`);
    expect(explainFailures(rows)).toBe("");
    expect(verdict(rows)).toBe(0);
  });

  test("the same workload twice costs the same — no flake to retry away", async () => {
    const golden = await goldenYear3Vault();
    const db = openVaultDb({ dir: golden.dir, sealKey: golden.sealKey });
    onTestFinished(() => db.close());
    const gateway = createGateway(db);
    const device = db.vault
      .prepare("SELECT device_id, public_key FROM access_device LIMIT 1")
      .get() as { device_id: string; public_key: string };
    const owner: Credential = {
      kind: "device",
      deviceId: device.device_id,
      deviceKey: device.public_key,
    };
    const read = (): WorkCounters =>
      costOf(() => {
        gateway.read(owner, { entity: "core.party", limit: 20 });
      });
    read();
    expect(read()).toStrictEqual(read());
  });
});
