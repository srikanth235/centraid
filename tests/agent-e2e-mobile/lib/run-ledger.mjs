import { promises as fs } from "node:fs";
import path from "node:path";

export const LEDGER_VERSION = 1;
export const MAX_RECORDS_PER_KEY = 500;
const WRITE_ATTEMPTS = 3;
const RETRY_DELAY_MS = 50;

export const DEFAULT_LEDGER_PATH = path.join(
  import.meta.dirname,
  "..",
  "ledger",
  "durations.json"
);

export function ledgerPathFromEnv(env = process.env) {
  const override = String(env.CENTRAID_MOBILE_LEDGER ?? "").trim();
  return override || DEFAULT_LEDGER_PATH;
}

const REQUIRED_FIELDS = [
  "flow",
  "slug",
  "platform",
  "device",
  "startedAt",
  "durationMs",
  "pass",
  "failureClass",
  "failureReason",
  "lane",
  "runId",
  "commit",
];

export function ledgerKey(record) {
  return `${record.flow}::${record.platform}`;
}

function validateRecord(record) {
  if (record == null || typeof record !== "object") {
    throw new TypeError("run ledger record must be an object");
  }
  for (const field of REQUIRED_FIELDS) {
    if (!Object.hasOwn(record, field)) {
      throw new TypeError(`run ledger record is missing "${field}"`);
    }
  }
  if (!record.flow || !record.platform) {
    throw new TypeError(
      'run ledger record needs a non-empty "flow" and "platform" — they are the window key'
    );
  }
  if (!Number.isFinite(record.durationMs)) {
    throw new TypeError('run ledger record needs a numeric "durationMs"');
  }
  return Object.fromEntries(REQUIRED_FIELDS.map((f) => [f, record[f]]));
}

async function readLedger(ledgerPath) {
  try {
    const parsed = JSON.parse(await fs.readFile(ledgerPath, "utf8"));
    return { version: LEDGER_VERSION, records: parsed.records ?? [] };
  } catch {
    return { version: LEDGER_VERSION, records: [] };
  }
}

export function boundedAppend(ledger, record) {
  const groups = new Map();
  for (const existing of [...(ledger.records ?? []), record]) {
    const key = ledgerKey(existing);
    groups.set(key, [...(groups.get(key) ?? []), existing]);
  }
  const records = [];
  for (const key of [...groups.keys()].sort()) {
    records.push(...groups.get(key).slice(-MAX_RECORDS_PER_KEY));
  }
  return { version: LEDGER_VERSION, records };
}

async function writeWithRetry(ledgerPath, record, attemptsLeft) {
  try {
    const next = boundedAppend(await readLedger(ledgerPath), record);
    await fs.mkdir(path.dirname(ledgerPath), { recursive: true });
    await fs.writeFile(ledgerPath, `${JSON.stringify(next, null, 2)}\n`);
    return next;
  } catch (error) {
    if (attemptsLeft <= 1) throw error;
    await new Promise((resolve) => {
      setTimeout(resolve, RETRY_DELAY_MS);
    });
    return writeWithRetry(ledgerPath, record, attemptsLeft - 1);
  }
}

export async function appendRunRecord(record, { ledgerPath } = {}) {
  return writeWithRetry(
    ledgerPath ?? ledgerPathFromEnv(),
    validateRecord(record),
    WRITE_ATTEMPTS
  );
}

export function percentile(values, p) {
  const sorted = [...values]
    .filter((value) => Number.isFinite(value))
    .sort((left, right) => left - right);
  if (sorted.length === 0) return null;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}

export function summarize(ledger) {
  const groups = new Map();
  for (const record of ledger?.records ?? []) {
    const key = ledgerKey(record);
    groups.set(key, [...(groups.get(key) ?? []), record]);
  }
  const summary = {};
  for (const key of [...groups.keys()].sort()) {
    const records = groups.get(key);
    const durations = records.map((record) => record.durationMs);
    const failures = records.filter((record) => record.pass === false);
    summary[key] = {
      flow: records[0].flow,
      platform: records[0].platform,
      runs: records.length,
      p50Ms: percentile(durations, 50),
      p95Ms: percentile(durations, 95),
      maxMs: percentile(durations, 100),
      failureRate: failures.length / records.length,
      infraFailureRate:
        failures.filter((record) => record.failureClass === "infrastructure")
          .length / records.length,
    };
  }
  return summary;
}
