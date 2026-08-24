/*
 * Shareable support bundle (#842 W8.1).
 *
 * This module builds the artifact an owner may choose to hand to somebody
 * ELSE — the single diagnostics document `makeDiagnosticsRouteHandler`
 * serves at `GET /centraid/_gateway/diagnostics` behind the host bearer
 * gate (#846 P8). Nothing here carries vault names or raw log lines.
 *
 * Two rules define it.
 *
 * **Nothing leaves without an explicit act.** There is no uploader here,
 * no endpoint, no client, no timer. `buildSupportBundle` returns a value;
 * `serializeSupportBundle` returns a string. Writing it somewhere and
 * sending it is the owner's action in the shell, not this module's.
 * The "no egress" block in `support-bundle.test.ts` asserts that
 * mechanically over the source of this file and its two dependencies, so a
 * future network primitive cannot be added here quietly.
 *
 * **Every field is emitted under a declared policy.** Nothing is copied.
 * The builder walks the inputs field by field through
 * `diagnostics-redaction.ts`'s `emitLeaf`, so a value that does not match
 * the shape its policy declares is refused rather than passed through, and
 * a field added upstream is absent here until somebody adds it here on
 * purpose. Free text is `prose`, which at the default `strict` level is
 * dropped in favour of a digest.
 *
 * The bundle is designed to stay USEFUL under that. What survives is the
 * shape of the failure rather than its contents: version and protocol,
 * platform, per-component health status and error counts, the anomaly
 * ledger (machine codes, severities, stack fingerprints, numeric facts),
 * a per-component/per-level histogram of the log tail with message
 * digests that the owner can grep for locally, storage sizes and row
 * counts, and the redaction report itself. `support-bundle.test.ts` pins
 * that usefulness as hard as it pins the redaction, because a bundle that
 * passes a leak sweep by being empty is the failure mode this whole slice
 * exists to avoid.
 */

import type { AnomalyRecord } from "./anomaly-ledger.js";
import {
  applyTripwire,
  emitLeaf,
  emptyRedactionReport,
  digest12,
  scrubUnknown,
} from "./diagnostics-redaction.js";
import type {
  LeafContext,
  RedactionLevel,
  RedactionReport,
} from "./diagnostics-redaction.js";

export const SUPPORT_BUNDLE_FORMAT_VERSION = 1;

/** How the bundle reaches anybody else. There is exactly one answer, and
 *  it is stamped into every document so the artifact states its own
 *  provenance rule. */
export const SUPPORT_BUNDLE_SHARING = "manual-owner-action" as const;

export interface SupportBundleLogEntry {
  readonly seq: number;
  readonly ts: number;
  readonly level: string;
  readonly message: string;
}

export interface SupportBundleHealthComponent {
  readonly component: string;
  readonly status: string;
  readonly errorCount: number;
  readonly detail?: string;
  readonly lastError?: string;
}

export interface SupportBundleStorage {
  readonly vaultId: string;
  /** Owner-authored. Never emitted; present so the tripwire can refuse it. */
  readonly name: string;
  readonly vaultDbBytes: number | null;
  readonly journalDbBytes: number | null;
  readonly tableRowCounts?: Readonly<Record<string, number>>;
}

export interface SupportBundleInput {
  readonly generatedAtMs: number;
  /** Salt for identifier hashing. One per bundle; caller-supplied so the
   *  build stays deterministic under test. */
  readonly salt: string;
  readonly level?: RedactionLevel;
  readonly gateway: {
    readonly version: string;
    readonly protocolVersion: number;
    readonly minSupportedProtocol: number;
  };
  readonly runtime: {
    readonly platform: string;
    readonly arch: string;
    readonly nodeVersion: string;
  };
  readonly health: {
    readonly status: string;
    readonly uptimeMs: number;
    readonly components: readonly SupportBundleHealthComponent[];
    readonly metrics?: Readonly<Record<string, unknown>>;
  };
  readonly anomalies: readonly AnomalyRecord[];
  readonly logs: readonly SupportBundleLogEntry[];
  readonly storage: readonly SupportBundleStorage[];
  /** Caller-assembled config summary of unknown shape. */
  readonly config?: unknown;
  /**
   * Literal values the caller KNOWS are sensitive on this machine — seal
   * key material, bearer tokens, owner-authored vault and person names,
   * configured secret values. Swept out of the serialized document as a
   * last gate; a hit is counted in `redaction.byRule.tripwire`.
   */
  readonly sensitiveLiterals?: readonly string[];
}

export interface SupportBundleLogGroup {
  readonly component: string;
  readonly level: string;
  readonly count: number;
  /** Distinct message digests in this group, newest-last, bounded. */
  readonly digests: readonly string[];
  /** Scrubbed skeletons. Empty at `strict`. */
  readonly templates: readonly string[];
}

export interface SupportBundle {
  readonly formatVersion: number;
  readonly generatedAt: string;
  readonly sharing: typeof SUPPORT_BUNDLE_SHARING;
  readonly disclosure: readonly string[];
  readonly gateway: Record<string, string | number | null>;
  readonly runtime: Record<string, string | number | null>;
  readonly health: {
    readonly status: string | number | null;
    readonly uptimeMs: string | number | null;
    readonly components: readonly Record<string, string | number | null>[];
    readonly metrics: unknown;
  };
  readonly anomalies: {
    readonly count: number;
    readonly histogram: Readonly<Record<string, number>>;
    readonly records: readonly Record<string, unknown>[];
  };
  readonly logs: {
    readonly count: number;
    readonly byLevel: Readonly<Record<string, number>>;
    readonly groups: readonly SupportBundleLogGroup[];
  };
  readonly storage: readonly Record<string, unknown>[];
  readonly config: unknown;
  readonly redaction: RedactionReport;
}

/** Bounded so a machine in a crash loop cannot produce a gigabyte. */
const MAX_ANOMALY_RECORDS = 200;
const MAX_LOG_GROUPS = 64;
const MAX_GROUP_DIGESTS = 8;
const MAX_TABLE_ROWS = 64;

/** The first token of a log line before `:` is this codebase's de-facto
 *  component prefix (`vault registry: created vault …`). Kept only when it
 *  is a short machine-ish phrase; anything else becomes `unknown`, because
 *  a prefix that is not a prefix is interpolated text. */
const COMPONENT_PREFIX = /^(?<component>[a-z][a-z0-9 _.-]{0,31}):/u;

function componentOf(message: string): string {
  const matched = COMPONENT_PREFIX.exec(message);
  return (matched?.groups?.component ?? "unknown").replaceAll(" ", "-");
}

const DISCLOSURE = [
  "Generated locally. Nothing in Centraid uploads this document; sharing it is an explicit owner action.",
  "Contains no vault content, no item bodies, no names, no file paths and no credentials.",
  "Log lines are reduced to component, level and a sha256 digest; at redaction level 'standard' a scrubbed message skeleton is also included.",
  "Identifiers are salted hashes, correlatable within this document only.",
  "Config values that read as machine settings (short, lowercase, no spaces) are kept verbatim; a credential stored under a key whose name is not secret-shaped is the one residual this policy relies on the tripwire for.",
  "redaction.byRule.tripwire above zero means a known-sensitive literal reached serialization and was removed there; report it.",
] as const;

function emitAnomaly(
  record: AnomalyRecord,
  context: LeafContext
): Record<string, unknown> {
  const facts: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record.facts))
    facts[key] =
      typeof value === "boolean"
        ? value
        : emitLeaf(value, value === null ? "drop" : "number", context);
  return {
    seq: emitLeaf(record.seq, "number", context),
    at: emitLeaf(record.at, "timestamp", context),
    kind: emitLeaf(record.kind, "enum", context),
    severity: emitLeaf(record.severity, "enum", context),
    code: emitLeaf(record.code, "enum", context),
    component: emitLeaf(record.component, "enum", context),
    messageDigest: emitLeaf(record.messageDigest, "enum", context),
    stack: record.stack.map((frame) => emitLeaf(frame, "enum", context)),
    facts,
  };
}

function groupLogs(
  logs: readonly SupportBundleLogEntry[],
  context: LeafContext
): { groups: SupportBundleLogGroup[]; byLevel: Record<string, number> } {
  const byLevel: Record<string, number> = {};
  const buckets = new Map<
    string,
    {
      component: string;
      level: string;
      count: number;
      digests: string[];
      templates: string[];
    }
  >();
  for (const entry of logs) {
    const level = String(entry.level);
    byLevel[level] = (byLevel[level] ?? 0) + 1;
    const component = componentOf(entry.message);
    const key = `${component} ${level}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { component, level, count: 0, digests: [], templates: [] };
      buckets.set(key, bucket);
    }
    bucket.count += 1;
    const stamp = digest12(entry.message);
    if (
      !bucket.digests.includes(stamp) &&
      bucket.digests.length < MAX_GROUP_DIGESTS
    )
      bucket.digests.push(stamp);
    if (
      context.report.level === "standard" &&
      bucket.templates.length < MAX_GROUP_DIGESTS
    ) {
      const template = emitLeaf(entry.message, "prose", context);
      if (typeof template === "string" && !bucket.templates.includes(template))
        bucket.templates.push(template);
    }
  }
  const groups = [...buckets.values()]
    .sort((left, right) => right.count - left.count)
    .slice(0, MAX_LOG_GROUPS)
    .map((bucket) => ({
      component: String(emitLeaf(bucket.component, "enum", context)),
      level: String(emitLeaf(bucket.level, "enum", context)),
      count: bucket.count,
      digests: bucket.digests,
      templates: bucket.templates,
    }));
  return { groups, byLevel };
}

function emitStorage(
  entry: SupportBundleStorage,
  context: LeafContext
): Record<string, unknown> {
  const counts: Record<string, unknown> = {};
  const rows = Object.entries(entry.tableRowCounts ?? {}).slice(
    0,
    MAX_TABLE_ROWS
  );
  for (const [table, count] of rows)
    counts[table] = emitLeaf(count, "number", context);
  return {
    vaultId: emitLeaf(entry.vaultId, "identifier", context),
    // The owner-authored vault name is NOT emitted under any level. It is
    // carried in the input purely so the tripwire can refuse it if some
    // other lane interpolated it into prose.
    vaultDbBytes: emitLeaf(entry.vaultDbBytes ?? 0, "number", context),
    journalDbBytes: emitLeaf(entry.journalDbBytes ?? 0, "number", context),
    tableRowCounts: counts,
  };
}

/**
 * Assemble the shareable bundle. Pure: no clock, no filesystem, no
 * network. `generatedAtMs` is the injected instant.
 */
export function buildSupportBundle(input: SupportBundleInput): SupportBundle {
  const report = emptyRedactionReport(input.level ?? "strict");
  const context: LeafContext = { report, salt: input.salt };
  const anomalies = input.anomalies.slice(-MAX_ANOMALY_RECORDS);
  const histogram: Record<string, number> = {};
  for (const record of input.anomalies)
    histogram[record.code] = (histogram[record.code] ?? 0) + 1;
  const { groups, byLevel } = groupLogs(input.logs, context);
  return {
    formatVersion: SUPPORT_BUNDLE_FORMAT_VERSION,
    generatedAt: new Date(input.generatedAtMs).toISOString(),
    sharing: SUPPORT_BUNDLE_SHARING,
    disclosure: [...DISCLOSURE],
    gateway: {
      version: emitLeaf(input.gateway.version, "verbatim", context),
      protocolVersion: emitLeaf(
        input.gateway.protocolVersion,
        "number",
        context
      ),
      minSupportedProtocol: emitLeaf(
        input.gateway.minSupportedProtocol,
        "number",
        context
      ),
    },
    runtime: {
      platform: emitLeaf(input.runtime.platform, "enum", context),
      arch: emitLeaf(input.runtime.arch, "enum", context),
      nodeVersion: emitLeaf(input.runtime.nodeVersion, "verbatim", context),
    },
    health: {
      status: emitLeaf(input.health.status, "enum", context),
      uptimeMs: emitLeaf(input.health.uptimeMs, "number", context),
      components: input.health.components.map((component) => ({
        component: emitLeaf(component.component, "enum", context),
        status: emitLeaf(component.status, "enum", context),
        errorCount: emitLeaf(component.errorCount, "number", context),
        detail: emitLeaf(component.detail ?? "", "prose", context),
        lastErrorDigest: emitLeaf(
          digest12(component.lastError ?? ""),
          "enum",
          context
        ),
      })),
      metrics: scrubUnknown(input.health.metrics ?? {}, context),
    },
    anomalies: {
      count: input.anomalies.length,
      histogram,
      records: anomalies.map((record) => emitAnomaly(record, context)),
    },
    logs: { count: input.logs.length, byLevel, groups },
    storage: input.storage.map((entry) => emitStorage(entry, context)),
    config: scrubUnknown(input.config ?? {}, context),
    redaction: report,
  };
}

export interface SerializedSupportBundle {
  readonly text: string;
  readonly bytes: number;
  readonly tripwireHits: number;
}

/**
 * Serialize and run the last gate. The tripwire sweep happens on the
 * SERIALIZED text, so it catches a sensitive literal no matter which lane
 * carried it, and its hit count is folded back into the document's own
 * redaction report before the final serialization.
 */
export function serializeSupportBundle(
  bundle: SupportBundle,
  sensitiveLiterals: readonly string[] = []
): SerializedSupportBundle {
  const first = applyTripwire(JSON.stringify(bundle), sensitiveLiterals);
  if (first.hits === 0)
    return { text: first.text, bytes: first.text.length, tripwireHits: 0 };
  const report: RedactionReport = {
    ...bundle.redaction,
    byRule: {
      ...bundle.redaction.byRule,
      tripwire: bundle.redaction.byRule.tripwire + first.hits,
    },
  };
  const second = applyTripwire(
    JSON.stringify({ ...bundle, redaction: report }),
    sensitiveLiterals
  );
  return {
    text: second.text,
    bytes: second.text.length,
    tripwireHits: first.hits,
  };
}

/** Build and serialize in one step — what a caller wiring an owner-facing
 *  "save diagnostics" action wants. */
export function renderSupportBundle(
  input: SupportBundleInput
): SerializedSupportBundle & { bundle: SupportBundle } {
  const bundle = buildSupportBundle(input);
  const serialized = serializeSupportBundle(
    bundle,
    input.sensitiveLiterals ?? []
  );
  return { ...serialized, bundle };
}
