/*
 * `vault-integrity` health component (#374, #659): `PRAGMA quick_check` over
 * `vault.db`, the one file (#916). It is a FULL file scan, never a per-tick
 * read — so a vault is re-checked on a size-scaled interval (1h floor, a day at
 * the ceiling), at most `maxChecksPerTick` vaults land in one tick, and nothing
 * is scanned during the startup grace, keeping a full read off the boot path.
 */

import type { DatabaseSync } from "node:sqlite";

import type { ComponentStatus, HealthProbe } from "./health-registry.js";

export interface VaultIntegrityEntry {
  readonly vaultId: string;
  readonly vault: DatabaseSync;
}

export interface VaultIntegrityHealthOptions {
  readonly vaults: () => readonly VaultIntegrityEntry[];
  readonly intervalMs?: number;
  readonly now?: () => number;
  readonly maxFailureLines?: number;
  readonly maxChecksPerTick?: number;
  readonly startupGraceMs?: number;
}

interface CachedCheck {
  ok: boolean;
  lines: string[];
  checkedAt: number;
  intervalMs: number;
}

const DEFAULT_INTERVAL_MS = 60 * 60 * 1000; // 1h floor — see module comment.
const DEFAULT_MAX_LINES = 3;
const DEFAULT_MAX_CHECKS_PER_TICK = 1;
const DEFAULT_STARTUP_GRACE_MS = 0;
const SMALL_VAULT_BYTES = 64 * 1024 * 1024;
const MAX_INTERVAL_MULTIPLIER = 24;

function fileBytes(db: DatabaseSync): number {
  const pageCount = (
    db.prepare("PRAGMA page_count").get() as { page_count?: number } | undefined
  )?.page_count;
  const pageSize = (
    db.prepare("PRAGMA page_size").get() as { page_size?: number } | undefined
  )?.page_size;
  return (pageCount ?? 0) * (pageSize ?? 0);
}

/** Linear in size, so cost per unit time stays roughly constant. */
export function integrityIntervalFor(bytes: number, floorMs: number): number {
  const multiplier = Math.min(
    MAX_INTERVAL_MULTIPLIER,
    Math.max(1, bytes / SMALL_VAULT_BYTES)
  );
  return Math.round(floorMs * multiplier);
}

/** `ok` iff the sole result row is literally `'ok'`. */
function runQuickCheck(
  db: DatabaseSync,
  file: "vault.db",
  maxLines: number
): { ok: boolean; lines: string[] } {
  try {
    const rows = db.prepare("PRAGMA quick_check").all() as {
      quick_check: string;
    }[];
    const ok = rows.length === 1 && rows[0]?.quick_check === "ok";
    if (ok) return { ok: true, lines: [] };
    return {
      ok: false,
      lines: rows.slice(0, maxLines).map((r) => `${file}: ${r.quick_check}`),
    };
  } catch (error) {
    return {
      ok: false,
      lines: [
        `${file}: ${error instanceof Error ? error.message : String(error)}`,
      ],
    };
  }
}

export function createVaultIntegrityHealthProbe(
  options: VaultIntegrityHealthOptions
): HealthProbe {
  const now = options.now ?? Date.now;
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const maxLines = options.maxFailureLines ?? DEFAULT_MAX_LINES;
  const cache = new Map<string, CachedCheck>();
  const maxChecksPerTick =
    options.maxChecksPerTick ?? DEFAULT_MAX_CHECKS_PER_TICK;
  const startupGraceMs = options.startupGraceMs ?? DEFAULT_STARTUP_GRACE_MS;
  const createdAt = now();

  return async () => {
    const vaults = options.vaults();
    if (vaults.length === 0)
      return { status: "ok", detail: "no vaults mounted" };

    const failing: string[] = [];
    let checkedNow = 0;
    const withinStartupGrace = now() - createdAt < startupGraceMs;

    for (const entry of vaults) {
      const cached = cache.get(entry.vaultId);
      if (cached) {
        if (!cached.ok)
          failing.push(
            `${entry.vaultId.slice(0, 8)}: ${cached.lines.join("; ")}`
          );
        if (now() - cached.checkedAt < cached.intervalMs) continue;
      }
      if (withinStartupGrace || checkedNow >= maxChecksPerTick) continue;
      checkedNow += 1;
      const vaultCheck = runQuickCheck(entry.vault, "vault.db", maxLines);
      const ok = vaultCheck.ok;
      const lines = vaultCheck.lines.slice(0, maxLines);
      // Size scaling is for HEALTHY vaults only; a failing one uses the floor.
      const nextIntervalMs = ok
        ? integrityIntervalFor(fileBytes(entry.vault), intervalMs)
        : intervalMs;
      cache.set(entry.vaultId, {
        ok,
        lines,
        checkedAt: now(),
        intervalMs: nextIntervalMs,
      });
      if (!ok)
        failing.push(`${entry.vaultId.slice(0, 8)}: ${lines.join("; ")}`);
    }

    const cadenceNote = `quick_check at least every ${Math.round(intervalMs / 60_000)}m, ${checkedNow} checked this tick`;
    const status: ComponentStatus = failing.length > 0 ? "error" : "ok";
    if (status === "error") {
      return {
        status,
        detail: `${failing.length} of ${vaults.length} vault(s) failed quick_check: ${failing.join(" | ")} (${cadenceNote})`,
      };
    }
    return {
      status,
      detail: `${vaults.length} vault${vaults.length === 1 ? "" : "s"} clean (${cadenceNote})`,
    };
  };
}
