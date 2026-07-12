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
 */

import type { DatabaseSync } from 'node:sqlite';
import type { ComponentStatus, HealthProbe } from './health-registry.js';

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
}

interface CachedCheck {
  ok: boolean;
  lines: string[];
  checkedAt: number;
}

const DEFAULT_INTERVAL_MS = 60 * 60 * 1000; // 1h — see module comment.
const DEFAULT_MAX_LINES = 3;

/** Runs `PRAGMA quick_check` on one handle. `ok` iff the sole result row is literally `'ok'`. */
function runQuickCheck(
  db: DatabaseSync,
  file: 'vault.db' | 'journal.db',
  maxLines: number,
): { ok: boolean; lines: string[] } {
  try {
    const rows = db.prepare('PRAGMA quick_check').all() as { quick_check: string }[];
    const ok = rows.length === 1 && rows[0]?.quick_check === 'ok';
    if (ok) return { ok: true, lines: [] };
    return { ok: false, lines: rows.slice(0, maxLines).map((r) => `${file}: ${r.quick_check}`) };
  } catch (err) {
    return { ok: false, lines: [`${file}: ${err instanceof Error ? err.message : String(err)}`] };
  }
}

/** Builds the `vault-integrity` component's `HealthProbe` (registered in `build-gateway.ts`). */
export function createVaultIntegrityHealthProbe(options: VaultIntegrityHealthOptions): HealthProbe {
  const now = options.now ?? Date.now;
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const maxLines = options.maxFailureLines ?? DEFAULT_MAX_LINES;
  // Keyed by vaultId — a vault dropped from the registry (unmounted) just
  // stops being read from here; nothing to evict, the map stays bounded by
  // the number of vaults ever seen this process lifetime.
  const cache = new Map<string, CachedCheck>();

  return async () => {
    const vaults = options.vaults();
    if (vaults.length === 0) return { status: 'ok', detail: 'no vaults mounted' };

    const failing: string[] = [];
    let checkedNow = 0;

    for (const entry of vaults) {
      const cached = cache.get(entry.vaultId);
      if (cached && now() - cached.checkedAt < intervalMs) {
        if (!cached.ok) failing.push(`${entry.vaultId.slice(0, 8)}: ${cached.lines.join('; ')}`);
        continue;
      }
      checkedNow += 1;
      const vaultCheck = runQuickCheck(entry.vault, 'vault.db', maxLines);
      const journalCheck = runQuickCheck(entry.journal, 'journal.db', maxLines);
      const ok = vaultCheck.ok && journalCheck.ok;
      const lines = [...vaultCheck.lines, ...journalCheck.lines].slice(0, maxLines);
      cache.set(entry.vaultId, { ok, lines, checkedAt: now() });
      if (!ok) failing.push(`${entry.vaultId.slice(0, 8)}: ${lines.join('; ')}`);
    }

    const cadenceNote = `quick_check every ${Math.round(intervalMs / 60_000)}m, ${checkedNow} checked this tick`;
    const status: ComponentStatus = failing.length > 0 ? 'error' : 'ok';
    if (status === 'error') {
      return {
        status,
        detail: `${failing.length} of ${vaults.length} vault(s) failed quick_check: ${failing.join(' | ')} (${cadenceNote})`,
      };
    }
    return {
      status,
      detail: `${vaults.length} vault${vaults.length === 1 ? '' : 's'} clean (${cadenceNote})`,
    };
  };
}
