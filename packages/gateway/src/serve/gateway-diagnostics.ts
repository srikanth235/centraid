/*
 * Diagnostics bundle assembly (issue #351, Tier 3 — "no diagnostics
 * bundle: a user cannot hand anything to support; logs die with the
 * process"). Served at `GET /centraid/_gateway/diagnostics`, behind the
 * same bearer gate as `_gateway/health` (see `routes/diagnostics-routes.ts`
 * — mirrors `routes/health-routes.ts` exactly).
 *
 * The document is designed to be saved to a file and attached to a
 * support request: version/platform, the current `HealthRegistry`
 * snapshot, a bounded log tail, cheap on-disk vault sizing (statSync
 * only — this never walks the blob CAS, which can be arbitrarily large),
 * a per-table size breakdown, and a config/runtime summary. The config
 * summary is REDACTED before it is ever assembled into the response: any
 * key that looks secret-shaped (token, secret, password, credential,
 * apiKey, …) is blanked recursively, however deep it's nested. This is a
 * blunt, key-name-based filter rather than a schema-aware one —
 * deliberately, so a NEW secret-shaped field added to config later is
 * caught by naming convention instead of requiring someone to remember to
 * extend an allowlist.
 *
 * `tableStats` (issue #367 §E1) is a SECOND, best-effort layer on top of
 * the cheap file sizes: `dbSizeBreakdown` opens a `dbstat` query (or falls
 * back to a row-count estimate) against the ALREADY-OPEN vault/journal
 * handles the mounted `VaultPlane` holds — no extra file I/O, no CAS walk.
 * It is wrapped in its own try/catch per vault so a stats query never turns
 * a working diagnostics bundle into a failed one.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  dbSizeBreakdown,
  scanInlineBodyViolations,
  type DbSizeBreakdown,
  type InlineBodyViolationScan,
  type VaultDb,
} from '@centraid/vault';
import type { GatewayLogEntry, GatewayLogStore } from './gateway-log-store.js';
import type { HealthRegistry, HealthSnapshot } from './health-registry.js';
import type { VaultRegistry } from './vault-registry.js';
import {
  GATEWAY_MIN_PROTOCOL_VERSION,
  GATEWAY_PROTOCOL_VERSION,
  GATEWAY_SCHEMA_EPOCH,
  GATEWAY_VERSION,
} from '../version.js';

/** Default + max entry counts for the embedded log tail. */
export const DEFAULT_DIAGNOSTICS_LOG_LIMIT = 500;

export interface DiagnosticsVaultFileSizes {
  /** `null` when the file doesn't exist (e.g. no `-wal` file present). */
  vaultDbBytes: number | null;
  vaultDbWalBytes: number | null;
  journalDbBytes: number | null;
  journalDbWalBytes: number | null;
}

/** Per-table size breakdown for one vault's two files (issue #367 §E1). */
export interface DiagnosticsTableStats {
  vaultDb: DbSizeBreakdown;
  journalDb: DbSizeBreakdown;
  /** Pre-existing inline text bodies already over the §E4 budget. */
  inlineBodyViolations: InlineBodyViolationScan;
}

export interface DiagnosticsVaultInfo {
  vaultId: string;
  name: string;
  files: DiagnosticsVaultFileSizes;
  /** Absent when the plane's live handles aren't available or the query failed. */
  tableStats?: DiagnosticsTableStats;
}

export interface DiagnosticsBundle {
  generatedAt: string;
  gateway: {
    version: string;
    protocolVersion: number;
    minSupportedProtocol: number;
    schemaEpoch: number;
  };
  runtime: {
    platform: NodeJS.Platform;
    arch: string;
    nodeVersion: string;
  };
  /** The live `HealthRegistry` snapshot — same shape `_gateway/health` returns. */
  health: HealthSnapshot;
  /** Newest-last log tail, bounded to `logLimit` (default 500). */
  logs: GatewayLogEntry[];
  vaults: DiagnosticsVaultInfo[];
  /** Caller-supplied config/runtime summary, REDACTED (see module header). */
  config: unknown;
}

export interface GatewayDiagnosticsOptions {
  health: HealthRegistry;
  logs: GatewayLogStore;
  vaults: VaultRegistry;
  /**
   * Arbitrary config/runtime summary to embed — paths, feature flags,
   * the backup provider config, etc. Redacted before assembly, so
   * callers should pass whatever is useful for support rather than
   * pre-filtering it themselves.
   */
  config?: unknown;
  /** Overrides `DEFAULT_DIAGNOSTICS_LOG_LIMIT`. */
  logLimit?: number;
}

/** Key names that mark a value as secret-shaped — matched case-insensitively
 *  against every object key, however deep. Intentionally broad: a false
 *  positive just redacts a harmless field, a false negative leaks a
 *  credential into something a user emails to support. */
const SECRET_KEY_PATTERN =
  /token|secret|password|passwd|credential|api[-_]?key|private[-_]?key|bearer|authorization|cookie/i;

const REDACTED = '[REDACTED]';

/** Deep-redact secret-shaped keys in an arbitrary JSON-ish value. Cycles
 *  aren't a concern — `config` is always caller-assembled plain data
 *  (paths, flags, parsed config objects), never a live class instance. */
function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SECRET_KEY_PATTERN.test(key) ? REDACTED : redact(v);
    }
    return out;
  }
  return value;
}

/** `statSync(file).size`, or `null` when the file doesn't exist (a vault
 *  may have no `-wal` file if it's not mid-transaction) or isn't readable. */
function fileSizeOrNull(file: string): number | null {
  try {
    return fs.statSync(file).size;
  } catch {
    return null;
  }
}

function vaultFileSizes(dir: string): DiagnosticsVaultFileSizes {
  return {
    vaultDbBytes: fileSizeOrNull(path.join(dir, 'vault.db')),
    vaultDbWalBytes: fileSizeOrNull(path.join(dir, 'vault.db-wal')),
    journalDbBytes: fileSizeOrNull(path.join(dir, 'journal.db')),
    journalDbWalBytes: fileSizeOrNull(path.join(dir, 'journal.db-wal')),
  };
}

/**
 * Best-effort table stats off a mounted plane's ALREADY-OPEN handles.
 * `undefined` (never throws) when the plane doesn't carry live handles —
 * true for every unit-test stub in this file's own tests, and a safe
 * degrade if a future caller ever hands this a plane mid-teardown.
 */
function tableStatsFor(plane: { db?: VaultDb }): DiagnosticsTableStats | undefined {
  try {
    const db = plane.db;
    if (!db) return undefined;
    return {
      vaultDb: dbSizeBreakdown(db.vault),
      journalDb: dbSizeBreakdown(db.journal),
      inlineBodyViolations: scanInlineBodyViolations(db.vault),
    };
  } catch {
    return undefined;
  }
}

/** Assemble the diagnostics bundle. Cheap: every vault size is a single
 *  `statSync` (no CAS walk), the log tail is a ring-buffer slice, and
 *  `health.snapshot()` only runs its registered probes (the same cost
 *  `_gateway/health` pays). */
export async function buildDiagnosticsBundle(
  options: GatewayDiagnosticsOptions,
): Promise<DiagnosticsBundle> {
  const health = await options.health.snapshot();
  const logLimit = options.logLimit ?? DEFAULT_DIAGNOSTICS_LOG_LIMIT;
  const allLogs = options.logs.snapshot();
  const logs = allLogs.length > logLimit ? allLogs.slice(allLogs.length - logLimit) : allLogs;

  const vaults: DiagnosticsVaultInfo[] = options.vaults.planesList().map((plane) => {
    const tableStats = tableStatsFor(plane);
    return {
      vaultId: plane.boot.vaultId,
      name: plane.name,
      files: vaultFileSizes(plane.dir),
      ...(tableStats ? { tableStats } : {}),
    };
  });

  return {
    generatedAt: new Date().toISOString(),
    gateway: {
      version: GATEWAY_VERSION,
      protocolVersion: GATEWAY_PROTOCOL_VERSION,
      minSupportedProtocol: GATEWAY_MIN_PROTOCOL_VERSION,
      schemaEpoch: GATEWAY_SCHEMA_EPOCH,
    },
    runtime: { platform: os.platform(), arch: os.arch(), nodeVersion: process.version },
    health,
    logs,
    vaults,
    config: redact(options.config ?? {}),
  };
}
