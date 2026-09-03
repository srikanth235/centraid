import { spawn } from "node:child_process";
import path from "node:path";

import { shouldRetry } from "./retry-policy.mjs";

const FLOWS_DIR = path.join(import.meta.dirname, "..", "flows");

export function fitsInBudget(remainingMs, costMs) {
  return remainingMs > 0 && remainingMs >= costMs;
}

function spawnFlow(file, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(FLOWS_DIR, file)], {
      env: { ...process.env, ...env },
      stdio: "inherit",
    });
    child.on("exit", (code) => resolve(code ?? 1));
    child.on("error", () => resolve(1));
  });
}

async function runFlowWithPolicy(file, { label, env, platform, remainingMs }) {
  const attemptStartedAt = Date.now();
  const code = await spawnFlow(file, env);
  if (code === 0) return 0;
  const attemptMs = Date.now() - attemptStartedAt;

  const verdict = await shouldRetry(file, platform, false).catch(() => ({
    retry: false,
    reason: "the run ledger could not be read; treating the failure as product",
  }));
  console.error(`[${label}] ${file} failed — ${verdict.reason}`);
  if (!verdict.retry) return code;

  const remainingForRetry = remainingMs == null ? Infinity : remainingMs();
  if (!fitsInBudget(remainingForRetry, attemptMs)) {
    console.error(
      `[${label}] ${file} NOT retried: the attempt cost ${Math.ceil(attemptMs / 1000)}s and ` +
        `${Math.max(0, Math.ceil(remainingForRetry / 1000))}s of budget remain. A retry that ` +
        `overruns the gate costs more than the signal it buys — treat this as infrastructure ` +
        `and re-run the lane.`
    );
    return code;
  }

  console.error(`[${label}] ${file} retry 1/1 (clean state)`);
  const retryCode = await spawnFlow(file, {
    ...env,
    CENTRAID_MOBILE_RETRY: "1",
  });
  if (retryCode === 0) {
    console.error(
      `[${label}] ${file} passed on the infrastructure retry; both attempts' ` +
        `evidence is in tests/agent-e2e-mobile/runs/ and both are in the ledger`
    );
  }
  return retryCode;
}

export async function runSuite({
  name,
  flows,
  budgetMs,
  lane,
  platform,
  canaryCount = 0,
  reuseAfter = null,
  onBudgetBreach = "",
}) {
  const baseEnv = {
    CENTRAID_MOBILE_LANE: process.env.CENTRAID_MOBILE_LANE ?? lane,
    ...(platform ? { MAESTRO_PLATFORM: platform } : {}),
  };
  const resolvedPlatform = platform ?? process.env.MAESTRO_PLATFORM;
  const startedAt = Date.now();
  const deadlineAt = startedAt + budgetMs;
  const remainingMs = () => deadlineAt - Date.now();

  async function runFrom(index, exitCode) {
    const file = flows[index];
    if (!file) return exitCode;
    if (remainingMs() <= 0) {
      console.error(
        `[${name}] FAIL: the ${budgetMs / 60_000}-minute budget was spent after ` +
          `${index} of ${flows.length} journey(s). The remaining ${flows.length - index} ` +
          `did not run. Do not raise the budget to buy time. ${onBudgetBreach}`.trim()
      );
      return 1;
    }
    const reuse = reuseAfter != null && index >= reuseAfter;
    const code = await runFlowWithPolicy(file, {
      label: name,
      platform: resolvedPlatform,
      remainingMs,
      env: {
        ...baseEnv,
        CENTRAID_MOBILE_DEADLINE_MS: String(deadlineAt),
        ...(reuse ? { MAESTRO_REUSE_PAIRED_STATE: "1" } : {}),
      },
    });
    if (code === 0) return runFrom(index + 1, exitCode);
    if (index < canaryCount) {
      console.error(
        `[${name}] FAIL: the shared prerequisite did not complete — the ` +
          `${flows.length - canaryCount} journey(s) after it were not run. Their ` +
          `verdicts would have named their own assertions, not the cause.`
      );
      return 1;
    }
    return runFrom(index + 1, 1);
  }

  let exitCode = await runFrom(0, 0);
  const elapsedMs = Date.now() - startedAt;
  console.log(
    `[${name}] aggregate ${Math.ceil(elapsedMs / 1000)}s / ${budgetMs / 1000}s budget`
  );
  if (elapsedMs >= budgetMs) {
    console.error(
      `[${name}] FAIL: ${flows.length} journeys exceeded ${budgetMs / 60_000} minutes. ` +
        `Do not raise the budget to buy time. ${onBudgetBreach}`.trim()
    );
    exitCode = 1;
  }
  return exitCode;
}
