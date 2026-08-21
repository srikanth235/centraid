/*
 * Live-gateway adapter for the shareable support bundle (#842 W8.1).
 *
 * `support-bundle.ts` is pure and knows nothing about this process. This
 * module is the one place that reads live gateway state and turns it into
 * a `SupportBundleInput`. It is deliberately a separate file so the pure
 * builder stays trivially testable and so the "no network primitive"
 * source scan over the builder means something.
 *
 * Its second job is the one that makes the tripwire real: HARVESTING the
 * literals this machine considers sensitive. A redaction policy can only
 * refuse shapes it recognises, so the strongest available check is to ask
 * the running system for the values it knows must never appear — the
 * owner-authored vault names, the owner's display name, the seal key and
 * identity seed in their encoded forms, and any host-supplied bearer
 * token — and sweep the serialized document for them by literal. A hit
 * means the policy missed something; the value is removed either way and
 * the miss is counted in the bundle's own report.
 *
 * Structural parameter types, not the concrete `HealthRegistry` /
 * `GatewayLogStore` / `VaultRegistry` classes: this file sits downstream
 * of all three and importing them would knot the serve graph for no gain.
 */

import { dbSizeBreakdown } from "@centraid/vault";
import type { VaultDb } from "@centraid/vault";

import type { AnomalyLedger } from "./anomaly-ledger.js";
import type { RedactionLevel } from "./diagnostics-redaction.js";
import type {
  SupportBundleInput,
  SupportBundleLogEntry,
  SupportBundleStorage,
} from "./support-bundle.js";

export interface SupportBundleHealthLike {
  snapshot: () => Promise<{
    status: string;
    uptimeMs: number;
    components: readonly {
      component: string;
      status: string;
      errorCount: number;
      detail?: string;
      lastError?: string;
    }[];
    metrics?: object;
  }>;
}

export interface SupportBundleLogsLike {
  snapshot: () => readonly {
    seq: number;
    ts: number;
    level: string;
    message: string;
  }[];
}

export interface SupportBundlePlaneLike {
  readonly name: string;
  readonly dir: string;
  readonly boot: { readonly vaultId: string };
  readonly db?: VaultDb;
}

export interface SupportBundleSourceOptions {
  readonly health: SupportBundleHealthLike;
  readonly logs: SupportBundleLogsLike;
  readonly anomalies: AnomalyLedger;
  readonly planes: readonly SupportBundlePlaneLike[];
  readonly gateway: SupportBundleInput["gateway"];
  readonly runtime: SupportBundleInput["runtime"];
  /** Injected instant — this module never reads the wall clock. */
  readonly generatedAtMs: number;
  /** Per-bundle identifier salt, supplied by the caller. */
  readonly salt: string;
  readonly level?: RedactionLevel;
  readonly config?: unknown;
  /** Host-known secrets (bearer tokens, provider credentials) to sweep. */
  readonly extraSensitive?: readonly string[];
}

/** How many of the biggest tables carry a row count into the bundle. */
const TOP_TABLES = 24;
/** Log tail depth. Grouped and digested downstream, so this is cheap. */
const LOG_TAIL = 1000;

function rowCounts(db: VaultDb | undefined): Record<string, number> {
  if (!db) return {};
  try {
    const breakdown = dbSizeBreakdown(db.vault);
    const out: Record<string, number> = {};
    for (const entry of breakdown.tables.slice(0, TOP_TABLES))
      out[entry.table] = entry.rows ?? entry.pages ?? 0;
    return out;
  } catch {
    // Stats are a nice-to-have; a failed query must not fail the bundle.
    return {};
  }
}

function ownerNames(db: VaultDb | undefined): string[] {
  if (!db) return [];
  try {
    const rows = db.vault
      .prepare("SELECT display_name FROM core_party WHERE kind = 'person'")
      .all() as { display_name?: unknown }[];
    return rows
      .map((row) => row.display_name)
      .filter((name): name is string => typeof name === "string");
  } catch {
    return [];
  }
}

/**
 * Every encoding of the key material that could plausibly appear in a
 * stringified structure. Cheap, and the alternative is trusting that no
 * lane ever hex-encodes a key into a log line.
 */
function keyEncodings(db: VaultDb | undefined): string[] {
  if (!db) return [];
  const out: string[] = [];
  for (const key of [db.sealKey, db.identitySeed]) {
    if (!key) continue;
    out.push(key.toString("hex"), key.toString("base64"));
  }
  return out;
}

/** Read live gateway state into a bundle input, harvesting the sensitive
 *  literals the tripwire sweeps for. */
export async function collectSupportBundleInput(
  options: SupportBundleSourceOptions
): Promise<SupportBundleInput> {
  const health = await options.health.snapshot();
  const allLogs = options.logs.snapshot();
  const logs: SupportBundleLogEntry[] = allLogs
    .slice(Math.max(0, allLogs.length - LOG_TAIL))
    .map((entry) => ({
      seq: entry.seq,
      ts: entry.ts,
      level: entry.level,
      message: entry.message,
    }));
  const storage: SupportBundleStorage[] = [];
  const sensitive = new Set<string>(options.extraSensitive);
  for (const plane of options.planes) {
    const sizes = plane.db ? dbSizeBreakdownSafe(plane.db) : null;
    storage.push({
      vaultId: plane.boot.vaultId,
      name: plane.name,
      vaultDbBytes: sizes?.vaultBytes ?? null,
      journalDbBytes: sizes?.journalBytes ?? null,
      tableRowCounts: rowCounts(plane.db),
    });
    sensitive.add(plane.name);
    sensitive.add(plane.dir);
    for (const name of ownerNames(plane.db)) sensitive.add(name);
    for (const encoded of keyEncodings(plane.db)) sensitive.add(encoded);
  }
  return {
    generatedAtMs: options.generatedAtMs,
    salt: options.salt,
    level: options.level ?? "strict",
    gateway: options.gateway,
    runtime: options.runtime,
    health: {
      status: health.status,
      uptimeMs: health.uptimeMs,
      components: health.components.map((component) => ({ ...component })),
      metrics: (health.metrics ?? {}) as Record<string, unknown>,
    },
    anomalies: options.anomalies.snapshot(),
    logs,
    storage,
    config: options.config,
    sensitiveLiterals: [...sensitive].filter((value) => value.length >= 4),
  };
}

function dbSizeBreakdownSafe(
  db: VaultDb
): { vaultBytes: number; journalBytes: number } | null {
  try {
    return {
      vaultBytes: dbSizeBreakdown(db.vault).fileBytesTotal,
      journalBytes: dbSizeBreakdown(db.journal).fileBytesTotal,
    };
  } catch {
    return null;
  }
}
