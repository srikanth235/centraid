import { spawn } from "node:child_process";
import path from "node:path";

const FLOWS = [
  "photos-permissions.mjs",
  "photos-library.mjs",
  "photos-viewer.mjs",
  "photos-search.mjs",
  "photos-select-write.mjs",
];
const BUDGET_MS = 8 * 60_000;
const flowsDir = path.join(import.meta.dirname, "flows");

function runFlow(file, reusePairedState) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(flowsDir, file)], {
      env: {
        ...process.env,
        ...(reusePairedState ? { MAESTRO_REUSE_PAIRED_STATE: "1" } : {}),
      },
      stdio: "inherit",
    });
    child.on("exit", (code) => resolve(code ?? 1));
    child.on("error", () => resolve(1));
  });
}

const startedAt = Date.now();
async function runRemainingFlows(index = 0, exitCode = 0) {
  const flow = FLOWS[index];
  if (!flow) return exitCode;
  // The denied-permission journey deliberately pairs an empty replica. Seed
  // before the library journey's fresh pairing so its first pull contains the
  // deterministic Photos corpus; only the three journeys after that reuse it.
  const code = await runFlow(flow, index > 1);
  return runRemainingFlows(index + 1, code === 0 ? exitCode : 1);
}
let exitCode = await runRemainingFlows();

const elapsedMs = Date.now() - startedAt;
console.log(
  `[photos-suite] aggregate ${Math.ceil(elapsedMs / 1000)}s / ${BUDGET_MS / 1000}s budget`
);
if (elapsedMs >= BUDGET_MS) {
  console.error(
    "[photos-suite] FAIL: the five Photos journeys exceeded eight minutes"
  );
  exitCode = 1;
}
process.exitCode = exitCode;
