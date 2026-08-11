import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../..");
const started = Date.now();
const result = spawnSync(
  "bun",
  ["run", "--cwd", "tools/recognition-automations", "test:live"],
  { cwd: root, stdio: "inherit" }
);
const passed = result.status === 0;
const artifactDir = path.join(root, "artifacts/enrichment-live");
mkdirSync(artifactDir, { recursive: true });
writeFileSync(
  path.join(artifactDir, "result.json"),
  `${JSON.stringify(
    {
      owner: "tools/recognition-automations/src/model-goldens.live.test.ts",
      lane: "enrichment-live",
      status: passed ? "passed" : "failed",
      capturedAt: new Date().toISOString(),
      durationMs: Date.now() - started,
      measurements: [
        { name: "wall clock", value: Date.now() - started, unit: "ms" },
      ],
      ...(passed
        ? {}
        : {
            error: `live-model suite exited ${result.status ?? "without a status"}`,
          }),
    },
    null,
    2
  )}\n`
);
process.exitCode = passed ? 0 : (result.status ?? 1);
