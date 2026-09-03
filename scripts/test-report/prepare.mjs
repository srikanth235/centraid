import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../..");

await Promise.all(
  [
    "artifacts/test-results",
    "artifacts/e2e",
    "artifacts/perf",
    "artifacts/scale",
  ].map((directory) => mkdir(path.join(root, directory), { recursive: true }))
);

const laneIndex = process.argv.indexOf("--lane");
const lane = laneIndex === -1 ? undefined : process.argv[laneIndex + 1];
if (lane) {
  const safe = String(lane).replace(/[^A-Za-z0-9._-]/gu, "_");
  const markerPath = path.join(
    root,
    "artifacts/test-results",
    `lane-starts-${safe}.json`
  );
  const markers = { [lane]: new Date().toISOString() };
  await writeFile(markerPath, `${JSON.stringify(markers, null, 2)}\n`, "utf8");
}
