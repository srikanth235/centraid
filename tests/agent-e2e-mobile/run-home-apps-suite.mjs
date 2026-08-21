// The five home-journey covers that are not Photos (issue #839, gap G8), run
// as one suite so they share ONE simulator boot and ONE fresh pairing.
//
// Shape is deliberately identical to run-photos-suite.mjs: the first flow pairs
// against the gateway, every later flow runs with MAESTRO_REUSE_PAIRED_STATE=1
// and relaunches into that paired profile instead of redeeming a second ticket.
// Every journey still writes an independent verdict, including after an earlier
// failure — a mid-run failure must not grey the later cells (#535 F4).
//
// Tally is NOT here: its journey is held under issue #831.

import { spawn } from "node:child_process";
import path from "node:path";

const FLOWS = [
  "docs-drive.mjs",
  "agenda-week.mjs",
  "notes-library.mjs",
  "tasks-board.mjs",
  "locker-gate.mjs",
];
// See flows/home-apps-budget.md for how this ceiling was derived and what to do
// when it is breached. Do not raise it to buy time.
const BUDGET_MS = 10 * 60_000;
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
  const code = await runFlow(flow, index > 0);
  return runRemainingFlows(index + 1, code === 0 ? exitCode : 1);
}
let exitCode = await runRemainingFlows();

const elapsedMs = Date.now() - startedAt;
console.log(
  `[home-apps-suite] aggregate ${Math.ceil(elapsedMs / 1000)}s / ${BUDGET_MS / 1000}s budget`
);
if (elapsedMs >= BUDGET_MS) {
  console.error(
    "[home-apps-suite] FAIL: the five home-app journeys exceeded ten minutes"
  );
  exitCode = 1;
}
process.exitCode = exitCode;
