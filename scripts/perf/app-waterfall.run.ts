/*
 * The measuring half of `bun run perf:waterfall` (#927). The comparison, the
 * verdicts and the rendering are in `app-waterfall.mjs` beside this file and
 * are unit-tested there; this opens the apps.
 *
 * It runs under the repo's TypeScript runner rather than as a plain Node script
 * because the golden year-3 artifact's generator is `@centraid/test-kit`, which
 * ships sources and no build. That is a deliberate property of the kit, so the
 * command comes to it rather than the other way round.
 */
import { performance } from "node:perf_hooks";

import { expect, test } from "vitest";

import { appQueryPath, diffCounters } from "@centraid/core/protocol";
import { serve } from "@centraid/server";
import { tempDir } from "@centraid/test-kit/temp-dir";
import { seedYear3Vault } from "@centraid/test-kit/year3-vault";
import { gatewayWorkCounters, sealAad, sealValue } from "@centraid/vault";

import {
  BASELINE,
  compareToBaseline,
  FIRST_PAINT,
  readBaseline,
  renderWaterfall,
  saveBaseline,
  warmSwitchTolerance,
} from "./app-waterfall.mjs";

test("open all eight apps against a year-3-shaped vault", async () => {
  const startedAt = Date.now();
  // The gateway founds its own Personal vault, and the SHARED year-3 generator
  // fills it. Not the cached golden ARTIFACT: that directory carries its own
  // seal-key custody and is opened directly by rigs, never mounted by a live
  // `serve()`. Same generator, same declared volume, one registry the gateway
  // owns end to end.
  const root = await tempDir("centraid-waterfall-");
  const token = "centraid-waterfall-token";
  const handle = await serve({
    paths: { vaultDir: `${root}/vault` },
    token,
  });
  const plane = handle.vaults.get(handle.vaults.defaultVaultId());
  if (!plane) throw new Error("the auto-founded Personal vault is not mounted");
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
    { parties: 500, photos: 2000, conversations: 20, turnsPerConversation: 6 }
  );
  const rows: Array<Record<string, unknown>> = [];
  try {
    for (const { app, query } of FIRST_PAINT) {
      const before = gatewayWorkCounters();
      const started = performance.now();
      // A query is a POST: the input is a body, not a query string.
      // oxlint-disable-next-line no-await-in-loop -- (#927) apps are opened ONE AT A TIME on purpose: parallel opens would measure contention between eight apps, not what a developer switching between them pays.
      const response = await fetch(`${handle.url}${appQueryPath(app, query)}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: "{}",
      });
      const durationMs = performance.now() - started;
      // oxlint-disable-next-line no-await-in-loop -- (#927) same serial run as above
      await response.arrayBuffer();
      const cost = diffCounters(before, gatewayWorkCounters());
      rows.push({
        app,
        query,
        status: response.status,
        durationMs,
        statements: cost.statements,
        rowsScanned: cost.rowsScanned,
        bytesRead: cost.bytesRead,
      });
    }
  } finally {
    await handle.close().catch(() => undefined);
  }

  const tolerance = warmSwitchTolerance();
  // Straight to the stream, not through `console`: the runner intercepts
  // console output of a passing test, and this command's whole product IS its
  // output.
  process.stdout.write(
    `${renderWaterfall(compareToBaseline(rows as never, readBaseline(), tolerance))}\n\n` +
      `opened ${rows.length} apps on a year-3-shaped vault in ${(
        (Date.now() - startedAt) /
        1000
      ).toFixed(1)}s; tolerance ${tolerance}% from tests/journeys.json\n`
  );
  if (process.env.CENTRAID_WATERFALL_SAVE === "1") {
    saveBaseline({ at: new Date().toISOString(), rows }, BASELINE);
    process.stdout.write(`baseline saved to ${BASELINE} (this machine only)\n`);
  }
  // An error page is not a first paint: a 4xx would otherwise be reported as a
  // very fast app.
  expect(rows.every((row) => row["status"] === 200)).toBe(true);
});
