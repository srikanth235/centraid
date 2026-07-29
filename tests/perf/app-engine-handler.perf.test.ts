import { writeFile } from "node:fs/promises";
import path from "node:path";

import { runHandler } from "@centraid/app-engine";
import {
  qualityRegressionBudget,
  recordQualityResult,
} from "@centraid/test-kit/quality-result";
import { tempDir } from "@centraid/test-kit/temp-dir";
import { describe, expect, test } from "vitest";

const OWNER = "tests/perf/app-engine-handler.perf.test.ts";
const RUNS = 20;

describe("app-engine-handler.perf", () => {
  test("runs isolated app handlers within the nightly regression ceiling", async () => {
    const appDir = await tempDir("app-engine-perf-");
    const handlerFile = path.join(appDir, "handler.js");
    await writeFile(
      handlerFile,
      "export default async ({ body }) => ({ value: body.value + 1 });"
    );
    const started = performance.now();
    await Array.from({ length: RUNS }, (_, value) => value).reduce(
      async (previous, value) => {
        await previous;
        const outcome = await runHandler({
          app: { id: "perf", dir: appDir },
          handlerFile,
          handlerKind: "action",
          args: { body: { value } },
        });
        expect(outcome.ok).toBe(true);
      },
      Promise.resolve()
    );
    const durationMs = performance.now() - started;
    const budget = await qualityRegressionBudget("perf", OWNER);
    const passed = budget == null || durationMs < budget;
    await recordQualityResult({
      lane: "perf",
      owner: OWNER,
      name: `${RUNS} isolated app handlers`,
      status: passed ? "passed" : "failed",
      measurements: [
        {
          name: "wall clock",
          value: durationMs,
          unit: "ms",
          ...(budget == null ? {} : { budget }),
        },
        { name: "mean handler", value: durationMs / RUNS, unit: "ms" },
      ],
    });
    expect(passed).toBe(true);
  });
});
