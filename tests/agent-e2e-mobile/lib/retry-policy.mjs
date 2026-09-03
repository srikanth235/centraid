import { promises as fs } from "node:fs";
import path from "node:path";

import { ledgerPathFromEnv } from "./run-ledger.mjs";

export async function lastRecord(
  flow,
  platform,
  ledgerPath = ledgerPathFromEnv()
) {
  const raw = await fs.readFile(ledgerPath, "utf8").catch(() => null);
  if (raw == null) return null;
  let ledger;
  try {
    ledger = JSON.parse(raw);
  } catch {
    return null;
  }
  const slug = path.posix.basename(flow, ".mjs");
  const matching = (ledger.records ?? []).filter(
    (record) =>
      (record.slug === slug ||
        path.posix.basename(record.flow ?? "") === flow) &&
      (platform == null || record.platform === platform)
  );
  return matching.at(-1) ?? null;
}

export function decideRetry({ record, alreadyRetried }) {
  if (alreadyRetried) {
    return {
      retry: false,
      reason:
        "already retried once this run — a flow that needs two attempts is not flaky, it is broken",
    };
  }
  if (record == null) {
    return {
      retry: false,
      reason:
        "no ledger record for the failed attempt, so its failure class is unknown; " +
        "an unknown class is treated as product, never as infrastructure",
    };
  }
  if (record.failureClass !== "infrastructure") {
    return {
      retry: false,
      reason: `failure classified ${record.failureClass ?? "product"} (${record.failureReason ?? "no reason recorded"}) — product assertions are never retried`,
    };
  }
  return {
    retry: true,
    reason: `failure classified infrastructure (${record.failureReason ?? record.signal ?? "no reason recorded"}) — one clean-state retry, both attempts' evidence kept`,
  };
}

export async function shouldRetry(flow, platform, alreadyRetried, ledgerPath) {
  const record = await lastRecord(flow, platform, ledgerPath);
  return decideRetry({ record, alreadyRetried });
}
