import type { DatabaseProvider } from "../stores/gateway-db.js";
import type { HarnessFailureClass } from "./runner.js";
import type { HarnessKind } from "./turn.js";

export interface HarnessHealthPolicy {
  readonly threshold: number;
  readonly cooldownMs: number;
}

export const HARNESS_HEALTH_POLICIES: Readonly<
  Record<HarnessFailureClass, HarnessHealthPolicy>
> = {
  spawn: { threshold: 2, cooldownMs: 60_000 },
  auth: { threshold: 1, cooldownMs: 0 },
  init: { threshold: 2, cooldownMs: 60_000 },
  timeout: { threshold: 2, cooldownMs: 60_000 },
  quota: { threshold: 1, cooldownMs: 2 * 60_000 },
  wedge: { threshold: 1, cooldownMs: 2 * 60_000 },
  exit: { threshold: 2, cooldownMs: 60_000 },
  unknown: { threshold: 3, cooldownMs: 60_000 },
};

export interface HarnessHealthStatus {
  readonly allowed: boolean;
  readonly breakerUntil?: number;
  readonly failureClass?: HarnessFailureClass;
  readonly halfOpen?: boolean;
}

export interface HarnessHealthEntry {
  workspaceContext: string;
  harnessKind: HarnessKind;
  failureClass: HarnessFailureClass;
  consecutiveFailures: number;
  state: "closed" | "open" | "half-open";
  breakerUntil?: number;
  lastError?: string;
  lastFailureAt?: number;
  lastOkAt?: number;
}

export interface HarnessHealthController {
  canAttempt: (
    workspaceContext: string,
    harnessKind: HarnessKind,
    now?: number
  ) => HarnessHealthStatus;
  reportFailure: (
    workspaceContext: string,
    harnessKind: HarnessKind,
    failureClass: HarnessFailureClass,
    error: string,
    now?: number
  ) => void;
  reportOk: (
    workspaceContext: string,
    harnessKind: HarnessKind,
    now?: number
  ) => void;
  reportPreflightOk: (
    workspaceContext: string,
    harnessKind: HarnessKind,
    now?: number
  ) => void;
  list: (workspaceContext?: string, now?: number) => HarnessHealthEntry[];
}

interface BreakerRow {
  workspace_context: string;
  harness_kind: HarnessKind;
  failure_class: HarnessFailureClass;
  consecutive_failures: number;
  breaker_until: number | null;
  half_open_claimed_at: number | null;
  last_error: string | null;
  last_failure_at: number | null;
  last_ok_at: number | null;
}

export class HarnessHealthStore implements HarnessHealthController {
  constructor(
    private readonly dbProvider: DatabaseProvider,
    private readonly policies: Readonly<
      Record<HarnessFailureClass, HarnessHealthPolicy>
    > = HARNESS_HEALTH_POLICIES
  ) {}

  canAttempt(
    workspaceContext: string,
    harnessKind: HarnessKind,
    now = Date.now()
  ): HarnessHealthStatus {
    const db = this.dbProvider();
    const rows = db
      .prepare(
        `SELECT workspace_context, harness_kind, failure_class, consecutive_failures,
                breaker_until, half_open_claimed_at, last_error,
                last_failure_at, last_ok_at
           FROM harness_health
          WHERE workspace_context = ? AND harness_kind = ? AND consecutive_failures > 0
          ORDER BY CASE failure_class WHEN 'auth' THEN 0 ELSE 1 END,
                   COALESCE(breaker_until, 0) DESC`
      )
      .all(workspaceContext, harnessKind) as unknown as BreakerRow[];
    for (const row of rows) {
      if (row.breaker_until === -1 || (row.breaker_until ?? 0) > now) {
        return {
          allowed: false,
          ...(row.breaker_until !== -1 && row.breaker_until !== null
            ? { breakerUntil: row.breaker_until }
            : {}),
          failureClass: row.failure_class,
        };
      }
      if (
        (row.failure_class === "timeout" || row.failure_class === "wedge") &&
        row.breaker_until !== null
      ) {
        const claim = db
          .prepare(
            `UPDATE harness_health
                SET half_open_claimed_at = ?
              WHERE workspace_context = ? AND harness_kind = ? AND failure_class = ?
                AND (half_open_claimed_at IS NULL OR half_open_claimed_at < ?)`
          )
          .run(
            now,
            workspaceContext,
            harnessKind,
            row.failure_class,
            now - 60_000
          );
        return Number(claim.changes) > 0
          ? { allowed: true, failureClass: row.failure_class, halfOpen: true }
          : { allowed: false, failureClass: row.failure_class };
      }
    }
    return { allowed: true };
  }

  reportFailure(
    workspaceContext: string,
    harnessKind: HarnessKind,
    failureClass: HarnessFailureClass,
    error: string,
    now = Date.now()
  ): void {
    const policy = this.policies[failureClass];
    const db = this.dbProvider();
    const current = db
      .prepare(
        `SELECT consecutive_failures
           FROM harness_health
          WHERE workspace_context = ? AND harness_kind = ? AND failure_class = ?`
      )
      .get(workspaceContext, harnessKind, failureClass) as
      | { consecutive_failures: number }
      | undefined;
    const count = (current?.consecutive_failures ?? 0) + 1;
    const breakerUntil =
      count < policy.threshold
        ? null
        : failureClass === "auth"
          ? -1
          : failureClass === "quota"
            ? now +
              Math.min(
                30 * 60_000,
                policy.cooldownMs * 2 ** Math.min(6, count - 1)
              )
            : now + policy.cooldownMs;
    db.prepare(
      `INSERT INTO harness_health (
         workspace_context, harness_kind, failure_class, consecutive_failures,
         breaker_until, half_open_claimed_at, last_error, last_failure_at
       ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?)
       ON CONFLICT(workspace_context, harness_kind, failure_class) DO UPDATE SET
         consecutive_failures = excluded.consecutive_failures,
         breaker_until = excluded.breaker_until,
         half_open_claimed_at = NULL,
         last_error = excluded.last_error,
         last_failure_at = excluded.last_failure_at`
    ).run(
      workspaceContext,
      harnessKind,
      failureClass,
      count,
      breakerUntil,
      error.slice(-4_000),
      now
    );
  }

  reportOk(
    workspaceContext: string,
    harnessKind: HarnessKind,
    now = Date.now()
  ): void {
    this.dbProvider()
      .prepare(
        `UPDATE harness_health
            SET consecutive_failures = 0, breaker_until = NULL,
                half_open_claimed_at = NULL, last_ok_at = ?
          WHERE workspace_context = ? AND harness_kind = ? AND failure_class <> 'auth'`
      )
      .run(now, workspaceContext, harnessKind);
  }

  reportPreflightOk(
    workspaceContext: string,
    harnessKind: HarnessKind,
    now = Date.now()
  ): void {
    this.dbProvider()
      .prepare(
        `UPDATE harness_health
            SET consecutive_failures = 0, breaker_until = NULL,
                half_open_claimed_at = NULL, last_ok_at = ?
          WHERE workspace_context = ? AND harness_kind = ? AND failure_class = 'auth'`
      )
      .run(now, workspaceContext, harnessKind);
  }

  list(workspaceContext?: string, now = Date.now()): HarnessHealthEntry[] {
    const rows = this.dbProvider()
      .prepare(
        `SELECT workspace_context, harness_kind, failure_class, consecutive_failures,
                breaker_until, half_open_claimed_at, last_error,
                last_failure_at, last_ok_at
           FROM harness_health
          WHERE (? IS NULL OR workspace_context = ?)
          ORDER BY workspace_context, harness_kind, failure_class`
      )
      .all(
        workspaceContext ?? null,
        workspaceContext ?? null
      ) as unknown as BreakerRow[];
    return rows.map((row) => {
      const state =
        row.consecutive_failures === 0
          ? "closed"
          : row.half_open_claimed_at !== null &&
              row.breaker_until !== null &&
              row.breaker_until !== -1 &&
              row.breaker_until <= now
            ? "half-open"
            : "open";
      return {
        workspaceContext: row.workspace_context,
        harnessKind: row.harness_kind,
        failureClass: row.failure_class,
        consecutiveFailures: row.consecutive_failures,
        state,
        ...(row.breaker_until !== null && row.breaker_until !== -1
          ? { breakerUntil: row.breaker_until }
          : {}),
        ...(row.last_error ? { lastError: row.last_error } : {}),
        ...(row.last_failure_at === null
          ? {}
          : { lastFailureAt: row.last_failure_at }),
        ...(row.last_ok_at === null ? {} : { lastOkAt: row.last_ok_at }),
      };
    });
  }
}
