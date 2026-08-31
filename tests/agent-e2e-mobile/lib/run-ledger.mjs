// The mobile agent-e2e run ledger (#890). Every `runFlow` verdict appends one
// record here so the numbers that govern this layer stop being arithmetic.
//
// WHAT READS IT. `summarize()` is the input to the W4 measured-p95 ratchets:
// today's suite budgets (flows/probes-budget.md, flows/home-apps-budget.md) are
// derived ceilings — a rate nobody measured, multiplied by a unit count — and
// every one of them says in as many words that it must be re-derived from an
// observed p95 once real runs exist. This file is where "real runs exist"
// becomes checkable. `infraFailureRate` is the second reader: a suite whose
// product failure rate is flat while its infra rate climbs has a rig problem,
// and the distinction is only trustworthy because `lib/failure-class.mjs`
// refuses to call an assertion timeout infrastructure.
//
// WHY BOUNDED, AND NOT A LOG. This file is COMMITTED — it is evidence, and the
// repo is its own system of record — so it must not grow without limit; a log
// that doubles the diff of every nightly is a log people delete. A percentile
// needs a WINDOW anyway, not a history: p95 over four years of runs describes a
// rig that no longer exists. `MAX_RECORDS_PER_KEY` is that window, per
// flow×platform, oldest dropped first.
//
// WHY READ-MODIFY-WRITE WITH A RETRY AND A STABLE SORT. The suite runners spawn
// flows sequentially, so within one job there is one writer. The two nightly
// platform jobs (`mobile-e2e-ios`, `mobile-e2e-android`) run on DIFFERENT
// runners against different checkouts, so they never contend for the file —
// they contend for the same lines at merge time instead. Records are therefore
// grouped by a stable `flow::platform` key and written one field per line, so
// an iOS append and an Android append touch disjoint line ranges and any
// conflict that does occur is local and resolvable by hand. The retry covers
// the one case that is genuinely concurrent: a partially written file from an
// interrupted run being read back.

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

/** `CENTRAID_MOBILE_LEDGER` exists so a test never writes the committed file. */
export function ledgerPathFromEnv(env = process.env) {
  const override = String(env.CENTRAID_MOBILE_LEDGER ?? "").trim();
  return override || DEFAULT_LEDGER_PATH;
}

/** Every field a record owes. A record missing one is refused rather than
 * stored half-blank: a ledger with holes in it is worse than no ledger,
 * because a summary computed over it still returns a number. */
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

/** The grouping key for every window, summary and sort in this module. */
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
  // Field order is fixed here, not taken from the caller's object: a stable
  // key order is what keeps a re-serialized ledger byte-identical to one an
  // earlier run wrote, so an unrelated append is not a whole-file diff.
  return Object.fromEntries(REQUIRED_FIELDS.map((f) => [f, record[f]]));
}

async function readLedger(ledgerPath) {
  try {
    const parsed = JSON.parse(await fs.readFile(ledgerPath, "utf8"));
    return { version: LEDGER_VERSION, records: parsed.records ?? [] };
  } catch {
    // A ledger that does not exist yet and a ledger caught mid-write both read
    // as "no usable prior records". The retry above re-reads before deciding
    // the file is genuinely absent, so a torn read costs a record at most once.
    return { version: LEDGER_VERSION, records: [] };
  }
}

/** Append one record and re-window every key. Pure — exported for the test. */
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

/**
 * Append one flow run to the ledger and return the ledger as written.
 *
 * `async` so that EVERY failure mode is a rejection, validation included. A
 * function that rejects for I/O and throws synchronously for a bad record has
 * two error contracts, and callers reliably guard only the one they saw first.
 *
 * @param {object} record `{flow, slug, platform, device, startedAt, durationMs,
 *   pass, failureClass, failureReason, lane, runId, commit}`
 */
export async function appendRunRecord(record, { ledgerPath } = {}) {
  return writeWithRetry(
    ledgerPath ?? ledgerPathFromEnv(),
    validateRecord(record),
    WRITE_ATTEMPTS
  );
}

/**
 * Nearest-rank percentile: `percentile(values, 95)` is the smallest observation
 * at or above 95% of the sample. Nearest-rank rather than an interpolating
 * variant because every consumer here is a BUDGET — a ceiling has to be a value
 * the rig actually produced, not one averaged between two it did.
 */
export function percentile(values, p) {
  const sorted = [...values]
    .filter((value) => Number.isFinite(value))
    .sort((left, right) => left - right);
  if (sorted.length === 0) return null;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}

/**
 * Per flow×platform `{runs, p50Ms, p95Ms, maxMs, failureRate,
 * infraFailureRate}`, keyed by `flow::platform`. This is what a measured-p95
 * ratchet reads; a budget derived from it must cite `runs` (see
 * ledger/README.md) — a p95 over two samples is not a p95.
 */
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
