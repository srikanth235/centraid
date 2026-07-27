/*
 * The owner's two local-disk limits (issue #544), persisted in gateway.db.
 *
 * Two limits, two DELIBERATELY different enforcement models:
 *
 *   totalLimitBytes  — the budget the owner grants Centraid on this machine.
 *     WARN-ONLY. Crossing `warnAtPercent` degrades the `storage-limit` health
 *     component; crossing the limit turns it red. It NEVER refuses a write.
 *     A soft budget that silently fails a user's save would trade a number
 *     they can act on for data loss they cannot — the wrong trade every time.
 *     The hard floor stays where it always was: `disk-health.ts` reacting to
 *     real free space, which is a fact about the machine rather than a
 *     preference.
 *
 *   journalLimitBytes — the size at which the conversation/audit ledger
 *     starts archiving EARLY. This one is actuating, not advisory, because
 *     the action it triggers is non-destructive: archival seals cold rows
 *     into content-addressed CAS segments, and the prune half is already
 *     gated behind proven custody (issue #438). Reaching this limit changes
 *     WHEN archival runs and how far back its window reaches — never what it
 *     is allowed to delete.
 *
 * Both default to `null` — an existing gateway behaves exactly as it did
 * before the owner sets one.
 */

/* eslint-disable max-classes-per-file -- the typed refusal error is colocated with the store that throws it (#247) */

import { GatewayDatabase } from './gateway-db.js';

/** Default warn threshold as a percentage of `totalLimitBytes`. */
export const DEFAULT_WARN_AT_PERCENT = 80;

/** Refuse a ledger limit small enough that archival could never satisfy it —
 *  a freshly-VACUUMed journal with its schema and the active 7-day window
 *  still occupies real space, and a limit below this would keep the plane
 *  narrowing its window on every sweep forever. */
export const MIN_JOURNAL_LIMIT_BYTES = 64 * 1024 ** 2; // 64 MiB

/** Likewise, a total budget under this cannot hold a usable vault. */
export const MIN_TOTAL_LIMIT_BYTES = 256 * 1024 ** 2; // 256 MiB

export interface StorageLimits {
  /** Owner's disk budget for all of Centraid, or `null` for unlimited. */
  totalLimitBytes: number | null;
  /** Percent of `totalLimitBytes` at which the health component degrades. */
  warnAtPercent: number;
  /** `journal.db` size that triggers early archival, or `null` for off. */
  journalLimitBytes: number | null;
}

export const DEFAULT_STORAGE_LIMITS: StorageLimits = Object.freeze({
  totalLimitBytes: null,
  warnAtPercent: DEFAULT_WARN_AT_PERCENT,
  journalLimitBytes: null,
});

/** A rejected limits write — the route maps this to a 400 with `code`. */
export class StorageLimitsError extends Error {
  constructor(
    readonly code: 'invalid_total_limit' | 'invalid_journal_limit' | 'invalid_warn_percent',
    message: string,
  ) {
    super(message);
    this.name = 'StorageLimitsError';
  }
}

export async function loadStorageLimits(dir: string): Promise<StorageLimits> {
  const database = GatewayDatabase.open(dir);
  try {
    return await new StorageLimitsStore(database).load();
  } finally {
    database.close();
  }
}

export async function saveStorageLimits(dir: string, limits: StorageLimits): Promise<void> {
  const database = GatewayDatabase.open(dir);
  try {
    const store = new StorageLimitsStore(database);
    await store.update(limits);
  } finally {
    database.close();
  }
}

/** The write shape: every field optional, `null` clears that limit. */
export interface StorageLimitsPatch {
  totalLimitBytes?: number | null;
  warnAtPercent?: number;
  journalLimitBytes?: number | null;
}

/** Pure validator + merge — exported so the route and the tests exercise the
 *  SAME rules, and so a bad value is rejected before it reaches disk. */
export function applyLimitsPatch(current: StorageLimits, patch: StorageLimitsPatch): StorageLimits {
  const next: StorageLimits = { ...current };
  if ('totalLimitBytes' in patch) {
    const value = patch.totalLimitBytes;
    if (value !== null) {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < MIN_TOTAL_LIMIT_BYTES) {
        throw new StorageLimitsError(
          'invalid_total_limit',
          `total limit must be null or at least ${MIN_TOTAL_LIMIT_BYTES} bytes`,
        );
      }
      next.totalLimitBytes = Math.floor(value);
    } else {
      next.totalLimitBytes = null;
    }
  }
  if ('journalLimitBytes' in patch) {
    const value = patch.journalLimitBytes;
    if (value !== null) {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < MIN_JOURNAL_LIMIT_BYTES) {
        throw new StorageLimitsError(
          'invalid_journal_limit',
          `ledger limit must be null or at least ${MIN_JOURNAL_LIMIT_BYTES} bytes`,
        );
      }
      next.journalLimitBytes = Math.floor(value);
    } else {
      next.journalLimitBytes = null;
    }
  }
  if (patch.warnAtPercent !== undefined) {
    const value = patch.warnAtPercent;
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 100) {
      throw new StorageLimitsError(
        'invalid_warn_percent',
        'warn threshold must be a percentage in (0, 100]',
      );
    }
    next.warnAtPercent = value;
  }
  return next;
}

export type StorageLimitStatus = 'ok' | 'degraded' | 'error';

export interface StorageLimitEvaluation {
  status: StorageLimitStatus;
  /** `null` when no total limit is set — nothing to be a fraction of. */
  fractionUsed: number | null;
  usedBytes: number;
  limitBytes: number | null;
}

/**
 * Pure classifier for the total budget. Exported so the health probe, the
 * route, and the tests all read one rule.
 *
 * No limit ⇒ `ok` with a `null` fraction: an owner who never set a budget is
 * not "unhealthy", and free-space pressure is `disk-health.ts`'s job.
 */
export function evaluateStorageLimit(
  usedBytes: number,
  limits: StorageLimits,
): StorageLimitEvaluation {
  const limitBytes = limits.totalLimitBytes;
  if (limitBytes === null || limitBytes <= 0) {
    return { status: 'ok', fractionUsed: null, usedBytes, limitBytes: null };
  }
  const fractionUsed = usedBytes / limitBytes;
  const warnFraction = limits.warnAtPercent / 100;
  const status: StorageLimitStatus =
    fractionUsed >= 1 ? 'error' : fractionUsed >= warnFraction ? 'degraded' : 'ok';
  return { status, fractionUsed, usedBytes, limitBytes };
}

/** Thin object wrapper — the routes, the health probe, and every vault plane
 *  share ONE instance so a limit change takes effect everywhere at once,
 *  without a restart. */
export class StorageLimitsStore {
  private cached: StorageLimits | null = null;

  constructor(private readonly source: string | GatewayDatabase) {}

  async load(): Promise<StorageLimits> {
    if (this.cached) return this.cached;
    const limits =
      this.source instanceof GatewayDatabase
        ? this.loadFromDatabase()
        : await loadStorageLimits(this.source);
    this.cached = limits;
    return limits;
  }

  /**
   * The last-loaded limits, without touching disk. `VaultPlane`'s sweep reads
   * through this: the sweep runs on a timer inside a synchronous block and
   * must not await a file read to decide whether to archive. `load()` is
   * called once at build time, so this is populated before any sweep fires;
   * a caller that races that returns the defaults (limits off), which is the
   * safe direction — it delays early archival by one sweep instead of
   * triggering one on a limit nobody set.
   */
  current(): StorageLimits {
    return this.cached ?? { ...DEFAULT_STORAGE_LIMITS };
  }

  async update(patch: StorageLimitsPatch): Promise<StorageLimits> {
    const next = applyLimitsPatch(await this.load(), patch);
    if (this.source instanceof GatewayDatabase) {
      this.source.db
        .prepare(
          `INSERT INTO storage_limits (
            singleton, total_limit_bytes, warn_at_percent, journal_limit_bytes
          ) VALUES (1, ?, ?, ?)
          ON CONFLICT(singleton) DO UPDATE SET
            total_limit_bytes = excluded.total_limit_bytes,
            warn_at_percent = excluded.warn_at_percent,
            journal_limit_bytes = excluded.journal_limit_bytes`,
        )
        .run(next.totalLimitBytes, next.warnAtPercent, next.journalLimitBytes);
    } else {
      await saveStorageLimits(this.source, next);
    }
    this.cached = next;
    return next;
  }

  private loadFromDatabase(): StorageLimits {
    if (!(this.source instanceof GatewayDatabase)) return { ...DEFAULT_STORAGE_LIMITS };
    const row = this.source.db
      .prepare(
        `SELECT total_limit_bytes, warn_at_percent, journal_limit_bytes
           FROM storage_limits WHERE singleton = 1`,
      )
      .get() as
      | {
          total_limit_bytes: number | null;
          warn_at_percent: number;
          journal_limit_bytes: number | null;
        }
      | undefined;
    return row
      ? {
          totalLimitBytes: row.total_limit_bytes,
          warnAtPercent: row.warn_at_percent,
          journalLimitBytes: row.journal_limit_bytes,
        }
      : { ...DEFAULT_STORAGE_LIMITS };
  }
}
