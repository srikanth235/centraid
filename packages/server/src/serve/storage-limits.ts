/*
 * Two local-disk limits (#544), two enforcement models, both default `null`.
 *
 *   totalLimitBytes — WARN-ONLY. Crossing `warnAtPercent` degrades health;
 *     crossing the limit turns it red. NEVER refuses a write: a soft budget
 *     that fails a save trades a number for data loss. The hard floor is
 *     `disk-health.ts` reacting to real free space.
 *
 *   journalLimitBytes — actuating: archival starts EARLY. Non-destructive
 *     (CAS segments; prune already gated by custody, #438). Changes WHEN
 *     archival runs, never what it may delete.
 */

/* oxlint-disable max-classes-per-file -- the typed refusal error is colocated with the store that throws it (#247) */

import { GatewayDatabase } from "./gateway-db.js";

export const DEFAULT_WARN_AT_PERCENT = 80;

/** Floor: a VACUUMed journal plus the 7-day window still occupies this much;
 *  a smaller limit would narrow the window on every sweep forever. */
export const MIN_JOURNAL_LIMIT_BYTES = 64 * 1024 ** 2; // 64 MiB

export const MIN_TOTAL_LIMIT_BYTES = 256 * 1024 ** 2; // 256 MiB

export interface StorageLimits {
  totalLimitBytes: number | null;
  warnAtPercent: number;
  journalLimitBytes: number | null;
}

export const DEFAULT_STORAGE_LIMITS: StorageLimits = Object.freeze({
  totalLimitBytes: null,
  warnAtPercent: DEFAULT_WARN_AT_PERCENT,
  journalLimitBytes: null,
});

export class StorageLimitsError extends Error {
  constructor(
    readonly code:
      | "invalid_total_limit"
      | "invalid_journal_limit"
      | "invalid_warn_percent",
    message: string
  ) {
    super(message);
    this.name = "StorageLimitsError";
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

export async function saveStorageLimits(
  dir: string,
  limits: StorageLimits
): Promise<void> {
  const database = GatewayDatabase.open(dir);
  try {
    const store = new StorageLimitsStore(database);
    await store.update(limits);
  } finally {
    database.close();
  }
}

export interface StorageLimitsPatch {
  totalLimitBytes?: number | null;
  warnAtPercent?: number;
  journalLimitBytes?: number | null;
}

export function applyLimitsPatch(
  current: StorageLimits,
  patch: StorageLimitsPatch
): StorageLimits {
  const next: StorageLimits = { ...current };
  if ("totalLimitBytes" in patch) {
    const value = patch.totalLimitBytes;
    if (value === null) {
      next.totalLimitBytes = null;
    } else {
      if (
        typeof value !== "number" ||
        !Number.isFinite(value) ||
        value < MIN_TOTAL_LIMIT_BYTES
      ) {
        throw new StorageLimitsError(
          "invalid_total_limit",
          `total limit must be null or at least ${MIN_TOTAL_LIMIT_BYTES} bytes`
        );
      }
      next.totalLimitBytes = Math.floor(value);
    }
  }
  if ("journalLimitBytes" in patch) {
    const value = patch.journalLimitBytes;
    if (value === null) {
      next.journalLimitBytes = null;
    } else {
      if (
        typeof value !== "number" ||
        !Number.isFinite(value) ||
        value < MIN_JOURNAL_LIMIT_BYTES
      ) {
        throw new StorageLimitsError(
          "invalid_journal_limit",
          `ledger limit must be null or at least ${MIN_JOURNAL_LIMIT_BYTES} bytes`
        );
      }
      next.journalLimitBytes = Math.floor(value);
    }
  }
  if (patch.warnAtPercent !== undefined) {
    const value = patch.warnAtPercent;
    if (
      typeof value !== "number" ||
      !Number.isFinite(value) ||
      value <= 0 ||
      value > 100
    ) {
      throw new StorageLimitsError(
        "invalid_warn_percent",
        "warn threshold must be a percentage in (0, 100]"
      );
    }
    next.warnAtPercent = value;
  }
  return next;
}

export type StorageLimitStatus = "ok" | "degraded" | "error";

export interface StorageLimitEvaluation {
  status: StorageLimitStatus;
  fractionUsed: number | null;
  usedBytes: number;
  limitBytes: number | null;
}

/**
 * Total-budget classifier. No limit ⇒ `ok` + `null` fraction: unset is not
 * unhealthy; free-space pressure is `disk-health.ts`.
 */
export function evaluateStorageLimit(
  usedBytes: number,
  limits: StorageLimits
): StorageLimitEvaluation {
  const limitBytes = limits.totalLimitBytes;
  if (limitBytes === null || limitBytes <= 0) {
    return { status: "ok", fractionUsed: null, usedBytes, limitBytes: null };
  }
  const fractionUsed = usedBytes / limitBytes;
  const warnFraction = limits.warnAtPercent / 100;
  const status: StorageLimitStatus =
    fractionUsed >= 1
      ? "error"
      : fractionUsed >= warnFraction
        ? "degraded"
        : "ok";
  return { status, fractionUsed, usedBytes, limitBytes };
}

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
   * Last-loaded limits, no disk. `VaultPlane`'s sweep is sync and must not
   * await a file read. `load()` runs at build; a race returns defaults
   * (limits off) — delays archival one sweep rather than firing on unset.
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
            journal_limit_bytes = excluded.journal_limit_bytes`
        )
        .run(next.totalLimitBytes, next.warnAtPercent, next.journalLimitBytes);
    } else {
      await saveStorageLimits(this.source, next);
    }
    this.cached = next;
    return next;
  }

  private loadFromDatabase(): StorageLimits {
    if (!(this.source instanceof GatewayDatabase))
      return { ...DEFAULT_STORAGE_LIMITS };
    const row = this.source.db
      .prepare(
        `SELECT total_limit_bytes, warn_at_percent, journal_limit_bytes
           FROM storage_limits WHERE singleton = 1`
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
