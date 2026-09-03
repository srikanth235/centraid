import { dbSizeBreakdown } from "@centraid/vault";
import type { VaultDb } from "@centraid/vault";

import type { AnomalyRecord } from "./anomaly-ledger.js";
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
  readonly anomalies: { snapshot: () => readonly AnomalyRecord[] };
  readonly planes: readonly SupportBundlePlaneLike[];
  readonly gateway: SupportBundleInput["gateway"];
  readonly runtime: SupportBundleInput["runtime"];
  readonly generatedAtMs: number;
  readonly salt: string;
  readonly level?: RedactionLevel;
  readonly config?: unknown;
  readonly extraSensitive?: readonly string[];
}

const TOP_TABLES = 24;
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

function keyEncodings(db: VaultDb | undefined): string[] {
  if (!db) return [];
  const out: string[] = [];
  for (const key of [db.sealKey, db.identitySeed]) {
    if (!key) continue;
    out.push(key.toString("hex"), key.toString("base64"));
  }
  return out;
}

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

function dbSizeBreakdownSafe(db: VaultDb): { vaultBytes: number } | null {
  try {
    return { vaultBytes: dbSizeBreakdown(db.vault).fileBytesTotal };
  } catch {
    return null;
  }
}
