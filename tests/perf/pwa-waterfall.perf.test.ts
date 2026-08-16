import { readFile } from "node:fs/promises";

import { describe, expect, test } from "vitest";

import { recordQualityResult } from "@centraid/test-kit/quality-result";

import { perfBudgets } from "../../apps/web/tests/e2e/perf-budgets.js";
import { rigDriftBudgetMs } from "../helpers/rig-budgets.js";

const OWNER = "tests/perf/pwa-waterfall.perf.test.ts";
// Produced by the web-e2e Playwright job (perf-waterfall.spec.ts) and handed to
// this lane as an artifact. This is a CHROMIUM PWA request-waterfall report, not
// an on-device mobile measurement — the file was previously mislabeled
// "mobile-fast-path"; it gates web.performance, and mobile.performance stays a
// gap (see tests/matrix.json notes) until real on-device budgets exist.
const input = "artifacts/perf-input/pwa-waterfall-report.json";

interface WaterfallReport {
  shell: {
    cold: { requestCount: number; transferBytes: number };
    warmToColdByteRatio: number;
  };
  // An app open is an inline route in the shell window (#799 retired the
  // served-app iframe). `grandTotalTransferBytes` is what came off the WIRE and
  // is 0 while the service worker answers the app's chunks from Cache Storage;
  // `encodedBodyBytes` is the DECODED weight of those same bodies (Cache
  // Storage holds decoded bodies, so it is raw size, not a wire figure) and is
  // the number that grows when an app gets heavier. Both are gated.
  appOpen: {
    cold: {
      requestCount: number;
      totalRequestCount: number;
      grandTotalTransferBytes: number;
      encodedBodyBytes: number;
      elapsedMs: number;
    };
    warm: {
      requestCount: number;
      totalRequestCount: number;
      grandTotalTransferBytes: number;
      encodedBodyBytes: number;
      elapsedMs: number;
    };
    warmToColdByteRatio: number;
  };
}

async function readWaterfall(): Promise<WaterfallReport | undefined> {
  try {
    return JSON.parse(await readFile(input, "utf8")) as WaterfallReport;
  } catch {
    return undefined;
  }
}

const waterfall = await readWaterfall();

// The artifact is only ever missing when the upstream web-e2e job did not run or
// failed to publish it. Locally that is expected (skip). In CI it means the gate
// silently guarded nothing — the exact defect this reorg is closing — so fail
// hard instead of skipping into a false green.
if (process.env.CI && !waterfall) {
  throw new Error(
    `${OWNER}: missing ${input}. The nightly web-e2e job must publish the PWA ` +
      `waterfall report before the perf lane runs; a missing artifact is a hard ` +
      `failure in CI (it would otherwise gate nothing).`
  );
}

describe("pwa-waterfall.perf", () => {
  test.skipIf(!waterfall)(
    "the real #404 PWA fast-path browser budgets gate the nightly lane",
    async () => {
      const report = waterfall!;
      // #659 R4 — sustained-drift gate over this rig's own 30-sample
      // nightly history. Null until the history is deep enough; a null is
      // "no opinion yet", never a pass.
      const drift = await rigDriftBudgetMs("perf", OWNER);
      const passed =
        report.shell.cold.requestCount <= perfBudgets.shell.maxRequests &&
        report.shell.cold.transferBytes <= perfBudgets.shell.maxTransferBytes &&
        report.shell.warmToColdByteRatio <=
          perfBudgets.shell.maxWarmToColdByteRatio &&
        report.appOpen.cold.requestCount <=
          perfBudgets.appOpen.cold.maxRequests &&
        report.appOpen.cold.grandTotalTransferBytes <=
          perfBudgets.appOpen.cold.maxTransferBytes &&
        report.appOpen.cold.encodedBodyBytes <=
          perfBudgets.appOpen.cold.maxEncodedBytes &&
        report.appOpen.cold.totalRequestCount <=
          perfBudgets.appOpen.cold.maxTotalRequests &&
        // A cold open that loaded nothing is a broken measurement, not a fast
        // one. A bare `> 0` would not catch the realistic version of that —
        // the app chunk getting preloaded or folded into `boot`, leaving one
        // incidental byte in the window — so this is a real floor.
        report.appOpen.cold.encodedBodyBytes >=
          perfBudgets.appOpen.cold.minEncodedBytes &&
        report.appOpen.warm.requestCount <=
          perfBudgets.appOpen.warm.maxRequests &&
        report.appOpen.warm.totalRequestCount <=
          perfBudgets.appOpen.warm.maxTotalRequests &&
        report.appOpen.warm.grandTotalTransferBytes <=
          perfBudgets.appOpen.warm.maxTransferBytes &&
        report.appOpen.warm.encodedBodyBytes <=
          perfBudgets.appOpen.warm.maxEncodedBytes &&
        report.appOpen.warmToColdByteRatio <=
          perfBudgets.appOpen.maxWarmToColdByteRatio;
      const withinDrift =
        drift === null || report.shell.cold.requestCount <= drift;
      await recordQualityResult({
        lane: "perf",
        owner: OWNER,
        name: "#404 PWA fast-path waterfall",
        status: passed && withinDrift ? "passed" : "failed",
        measurements: [
          {
            name: "cold shell requests",
            value: report.shell.cold.requestCount,
            unit: "requests",
            budget: perfBudgets.shell.maxRequests,
          },
          {
            name: "cold shell transfer",
            value: report.shell.cold.transferBytes,
            unit: "bytes",
            budget: perfBudgets.shell.maxTransferBytes,
          },
          {
            name: "warm/cold shell bytes",
            value: report.shell.warmToColdByteRatio,
            unit: "ratio",
            budget: perfBudgets.shell.maxWarmToColdByteRatio,
          },
          {
            name: "cold app requests",
            value: report.appOpen.cold.requestCount,
            unit: "requests",
            budget: perfBudgets.appOpen.cold.maxRequests,
          },
          {
            name: "cold app transfer",
            value: report.appOpen.cold.grandTotalTransferBytes,
            unit: "bytes",
            budget: perfBudgets.appOpen.cold.maxTransferBytes,
          },
          {
            name: "cold app encoded",
            value: report.appOpen.cold.encodedBodyBytes,
            unit: "bytes",
            budget: perfBudgets.appOpen.cold.maxEncodedBytes,
          },
        ],
      });
      expect(
        withinDrift,
        `sustained drift: ${report.shell.cold.requestCount} vs drift budget ${drift} (1.5x the trailing median of the last 30 nightly samples)`
      ).toBe(true);
      expect(passed).toBe(true);
    }
  );
});
