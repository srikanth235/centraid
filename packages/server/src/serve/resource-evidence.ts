/*
 * Mobile resource evidence ledger (#842).
 *
 * The claim "Centraid is well-behaved on a phone" needs numbers, and most
 * of the numbers that matter — battery drain per hour of foreground use,
 * peak resident memory under a real photo import, cold-start time on a
 * five-year-old Android — can only be produced by a real device. This repo
 * has no device. That is a genuine external block, not a gap somebody
 * forgot to close.
 *
 * The block is on the MEASUREMENT, not on the record. This module is the
 * record: a schema for what must be measured, on which surfaces, and a
 * validator that refuses the two ways such a ledger normally rots.
 *
 *  - **A blocked row must say what unblocks it.** `method: "blocked-external"`
 *    requires `blockedReason` and `unblockCondition` and forbids a value.
 *    A blocked lane is loud, cited, and countable — never silently absent.
 *  - **A measured row must be re-derivable.** `method: "measured"` and
 *    `method: "derived"` require a value, a `recomputedBy` pointing at the
 *    test that reproduces it, and a `tolerance`. The named test recomputes
 *    the number and fails when the ledger and the machine disagree, so a
 *    row cannot decay into a claim nobody checks.
 *
 * `derived` is the honest middle: a host-measured proxy for a device
 * quantity (on-disk vault bytes per thousand items is the same SQLite
 * layout on a phone; battery is not). A `derived` row never claims to be a
 * device measurement — `validateResourceLedger` refuses a `derived` row
 * whose `device.class` is anything but `host-proxy`.
 *
 * Determinism: no clock here. `at` is supplied by whoever writes a row.
 */

export const RESOURCE_SURFACES = ["ios", "android", "host-proxy"] as const;
export type ResourceSurface = (typeof RESOURCE_SURFACES)[number];

export const RESOURCE_METRICS = [
  "battery-drain-pct-per-hour",
  "peak-rss-mb",
  "cold-start-ms",
  "vault-bytes-per-1k-items",
  "sync-bytes-per-pass",
  "support-bundle-bytes",
] as const;
export type ResourceMetric = (typeof RESOURCE_METRICS)[number];

export const RESOURCE_METHODS = [
  "measured",
  "derived",
  "blocked-external",
] as const;
export type ResourceMethod = (typeof RESOURCE_METHODS)[number];

export const RESOURCE_DEVICE_CLASSES = [
  "host-proxy",
  "phone-current",
  "phone-legacy",
  "tablet",
] as const;
export type ResourceDeviceClass = (typeof RESOURCE_DEVICE_CLASSES)[number];

export interface ResourceDevice {
  readonly model: string;
  readonly os: string;
  readonly class: ResourceDeviceClass;
}

export interface ResourceObservation {
  readonly id: string;
  readonly surface: ResourceSurface;
  readonly metric: ResourceMetric;
  readonly method: ResourceMethod;
  /** `null` exactly when `method` is `blocked-external`. */
  readonly value: number | null;
  readonly unit: string;
  readonly device: ResourceDevice;
  /** ISO instant the row was written, or the measurement's date. */
  readonly at: string;
  /** Repo-relative path or issue link a reader follows to the evidence. */
  readonly evidence: string;
  /** Test that reproduces `value`. Required for measured/derived rows. */
  readonly recomputedBy?: string;
  /** Fractional band the recomputation may differ by, e.g. 0.2 = ±20%. */
  readonly tolerance?: number;
  readonly blockedReason?: string;
  readonly unblockCondition?: string;
  readonly note?: string;
}

export interface ResourceLedger {
  readonly schemaVersion: number;
  readonly observations: readonly ResourceObservation[];
}

export const RESOURCE_LEDGER_SCHEMA_VERSION = 1;

/**
 * Every (surface, metric) pair the ledger must carry a row for. A pair
 * with no row is a silently-absent lane, which is the failure this whole
 * ledger exists to prevent; the validator reports it as an error, so the
 * only two legal states for a lane are "measured" and "blocked, with the
 * unblock condition written down".
 */
export const REQUIRED_RESOURCE_LANES: readonly (readonly [
  ResourceSurface,
  ResourceMetric,
])[] = [
  ["ios", "battery-drain-pct-per-hour"],
  ["ios", "peak-rss-mb"],
  ["ios", "cold-start-ms"],
  ["android", "battery-drain-pct-per-hour"],
  ["android", "peak-rss-mb"],
  ["android", "cold-start-ms"],
  ["host-proxy", "vault-bytes-per-1k-items"],
  ["host-proxy", "sync-bytes-per-pass"],
  ["host-proxy", "support-bundle-bytes"],
];

const ISO_SHAPE = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z)?$/u;

function checkRow(row: ResourceObservation, errors: string[]): void {
  const where = `${row.id}`;
  if (!RESOURCE_SURFACES.includes(row.surface))
    errors.push(`${where}: unknown surface ${row.surface}`);
  if (!RESOURCE_METRICS.includes(row.metric))
    errors.push(`${where}: unknown metric ${row.metric}`);
  if (!RESOURCE_METHODS.includes(row.method))
    errors.push(`${where}: unknown method ${row.method}`);
  if (!RESOURCE_DEVICE_CLASSES.includes(row.device.class))
    errors.push(`${where}: unknown device class ${row.device.class}`);
  if (!ISO_SHAPE.test(row.at)) errors.push(`${where}: at is not ISO-8601`);
  if (row.evidence.trim().length === 0)
    errors.push(`${where}: evidence is required`);
  if (row.method === "blocked-external") {
    if (row.value !== null)
      errors.push(`${where}: a blocked-external row must carry value: null`);
    if (!row.blockedReason)
      errors.push(`${where}: blocked-external needs blockedReason`);
    if (!row.unblockCondition)
      errors.push(`${where}: blocked-external needs unblockCondition`);
    return;
  }
  if (typeof row.value !== "number" || !Number.isFinite(row.value))
    errors.push(`${where}: ${row.method} needs a finite value`);
  if (!row.recomputedBy)
    errors.push(
      `${where}: ${row.method} needs recomputedBy naming the test that reproduces it`
    );
  if (typeof row.tolerance !== "number" || row.tolerance <= 0)
    errors.push(`${where}: ${row.method} needs a positive tolerance`);
  if (row.method === "derived" && row.device.class !== "host-proxy")
    errors.push(
      `${where}: a derived row is a host proxy and may not claim a device class`
    );
  if (row.method === "measured" && row.device.class === "host-proxy")
    errors.push(
      `${where}: a measured row on a host proxy is derived, not measured`
    );
}

export interface ResourceLedgerValidation {
  readonly errors: readonly string[];
  readonly blocked: readonly ResourceObservation[];
  readonly recorded: readonly ResourceObservation[];
}

export function validateResourceLedger(
  ledger: ResourceLedger
): ResourceLedgerValidation {
  const errors: string[] = [];
  if (ledger.schemaVersion !== RESOURCE_LEDGER_SCHEMA_VERSION)
    errors.push(
      `schemaVersion ${ledger.schemaVersion} != ${RESOURCE_LEDGER_SCHEMA_VERSION}`
    );
  const seen = new Set<string>();
  for (const row of ledger.observations) {
    if (seen.has(row.id)) errors.push(`${row.id}: duplicate id`);
    seen.add(row.id);
    checkRow(row, errors);
  }
  const lanes = new Set(
    ledger.observations.map((row) => `${row.surface}/${row.metric}`)
  );
  for (const [surface, metric] of REQUIRED_RESOURCE_LANES)
    if (!lanes.has(`${surface}/${metric}`))
      errors.push(
        `lane ${surface}/${metric} has no row — a lane is measured or blocked-with-a-reason, never absent`
      );
  return {
    errors,
    blocked: ledger.observations.filter(
      (row) => row.method === "blocked-external"
    ),
    recorded: ledger.observations.filter(
      (row) => row.method !== "blocked-external"
    ),
  };
}

/** True when `observed` sits inside the row's recorded tolerance band. */
export function withinTolerance(
  row: ResourceObservation,
  observed: number
): boolean {
  if (typeof row.value !== "number" || typeof row.tolerance !== "number")
    return false;
  if (row.value === 0) return observed === 0;
  return Math.abs(observed - row.value) / Math.abs(row.value) <= row.tolerance;
}
