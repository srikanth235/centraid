/*
 * SQLite on-disk integrity — the `vault-integrity` health component (issue
 * #374 tier 5b).
 *
 * The `vaults` probe (`build-gateway.ts`) already runs `PRAGMA user_version`
 * every tick to prove a mounted plane's file still OPENS; that says nothing
 * about whether its b-trees, indexes, and the FTS shadow tables underneath
 * are actually intact. `PRAGMA quick_check` is SQLite's cheaper cousin of
 * `integrity_check` (skips the exhaustive UNIQUE-constraint verification)
 * but is still a full logical scan of every table and index — NOT a cheap
 * per-tick read on a vault with any real amount of data. So this probe
 * self-throttles: each mounted vault is re-checked at most once per
 * `intervalMs` (default 1h, matching the conservative cadence the sibling
 * `blob-sweep`/`scheduler` probes use for their own "how stale is stale"
 * thresholds), and every tick in between reuses the last result instead of
 * re-running the scan.
 *
 * Checks both `vault.db` and `journal.db` — corruption in the audit-trail
 * file is just as much a "this vault needs an operator" signal as the model
 * data.
 *
 * Issue #659 L6 made the cadence and the per-tick budget scale, because a fixed
 * hourly full-file scan per vault does not: quick_check reads every page, so its
 * cost grows with the vault while its VALUE (catching silent corruption before
 * a backup captures it) does not. So:
 *
 *   · the interval per vault scales with that vault's on-disk size, from the
 *     1h floor for a small vault up to a day for a large one;
 *   · at most `maxChecksPerTick` vaults are scanned in any one tick, so N
 *     mounted vaults can never line up into one N-file scan; and
 *   · nothing is scanned during the startup grace, keeping a full read of every
 *     mounted vault off the boot path (#659 G10).
 */

import type { DatabaseSync } from "node:sqlite";

import type { ComponentStatus, HealthProbe } from "./health-registry.js";

export interface VaultIntegrityEntry {
  readonly vaultId: string;
  readonly vault: DatabaseSync;
  readonly journal: DatabaseSync;
}

export interface VaultIntegrityHealthOptions {
  readonly vaults: () => readonly VaultIntegrityEntry[];
  /**
   * How often to re-run `quick_check` per vault. Defaults to 1h — see the
   * module comment on why this can't be every tick.
   */
  readonly intervalMs?: number;
  /** Clock override (tests). */
  readonly now?: () => number;
  /** How many failure lines to surface in `detail`, per vault. Defaults to 3. */
  readonly maxFailureLines?: number;
  /** Vaults scanned in any one tick. Defaults to 1 (issue #659 L6). */
  readonly maxChecksPerTick?: number;
  /**
   * Delay before the first scan may run, measured from construction. The
   * gateway sets this so a full-file read is never part of boot (#659 G10).
   */
  readonly startupGraceMs?: number;
}

interface CachedCheck {
  ok: boolean;
  lines: string[];
  checkedAt: number;
  /** Size-scaled cadence chosen when this result was produced (#659 L6). */
  intervalMs: number;
}

const DEFAULT_INTERVAL_MS = 60 * 60 * 1000; // 1h floor — see module comment.
const DEFAULT_MAX_LINES = 3;
/** One vault per tick: a scan is a full file read, never a batch operation. */
const DEFAULT_MAX_CHECKS_PER_TICK = 1;
/**
 * Boot is the worst moment to read every page of every vault, but WHEN the
 * first tick lands is the host's business, not the probe's — build-gateway
 * passes the real grace at registration. Zero here keeps the probe honest for
 * any caller that just wants a check.
 */
const DEFAULT_STARTUP_GRACE_MS = 0;
/** A vault at or below this size scans at the interval floor. */
const SMALL_VAULT_BYTES = 64 * 1024 * 1024;
/** Ceiling on the size scaling: never rarer than once a day. */
const MAX_INTERVAL_MULTIPLIER = 24;

/** On-disk bytes of an open handle, from two O(1) header reads. */
function fileBytes(db: DatabaseSync): number {
  const pageCount = (
    db.prepare("PRAGMA page_count").get() as { page_count?: number } | undefined
  )?.page_count;
  const pageSize = (
    db.prepare("PRAGMA page_size").get() as { page_size?: number } | undefined
  )?.page_size;
  return (pageCount ?? 0) * (pageSize ?? 0);
}

/**
 * Scan cadence for one vault: the floor for anything small, stretching linearly
 * with size to a daily scan for a large one. Cost per unit time is therefore
 * roughly constant instead of growing with the vault.
 */
export function integrityIntervalFor(bytes: number, floorMs: number): number {
  const multiplier = Math.min(
    MAX_INTERVAL_MULTIPLIER,
    Math.max(1, bytes / SMALL_VAULT_BYTES)
  );
  return Math.round(floorMs * multiplier);
}

/** Runs `PRAGMA quick_check` on one handle. `ok` iff the sole result row is literally `'ok'`. */
function runQuickCheck(
  db: DatabaseSync,
  file: "vault.db" | "journal.db",
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

/** Builds the `vault-integrity` component's `HealthProbe` (registered in `build-gateway.ts`). */
export function createVaultIntegrityHealthProbe(
  options: VaultIntegrityHealthOptions
): HealthProbe {
  const now = options.now ?? Date.now;
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const maxLines = options.maxFailureLines ?? DEFAULT_MAX_LINES;
  // Keyed by vaultId — a vault dropped from the registry (unmounted) just
  // stops being read from here; nothing to evict, the map stays bounded by
  // the number of vaults ever seen this process lifetime.
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
      // Budgeted: a vault that is due but over budget simply waits for the next
      // tick, keeping any single tick's cost to one vault's worth of scanning.
      if (withinStartupGrace || checkedNow >= maxChecksPerTick) continue;
      checkedNow += 1;
      const vaultCheck = runQuickCheck(entry.vault, "vault.db", maxLines);
      const journalCheck = runQuickCheck(entry.journal, "journal.db", maxLines);
      const ok = vaultCheck.ok && journalCheck.ok;
      const lines = [...vaultCheck.lines, ...journalCheck.lines].slice(
        0,
        maxLines
      );
      // Size scaling only applies to a HEALTHY vault: a failing one is
      // re-checked at the floor cadence (and its handle may not answer a header
      // read at all, which is how the failure surfaced).
      const nextIntervalMs = ok
        ? integrityIntervalFor(
            fileBytes(entry.vault) + fileBytes(entry.journal),
            intervalMs
          )
        : intervalMs;
      cache.set(entry.vaultId, {
        ok,
        lines,
        checkedAt: now(),
        intervalMs: nextIntervalMs,
      });
      // A freshly failing vault was not in `cached` above, so report it here.
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
