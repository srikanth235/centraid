/*
 * Persistent ACP runner health and circuit breakers (#567).
 *
 * Breakers are scoped to workspace context × runner × failure class. Auth is
 * indefinite until a real ACP preflight succeeds; quota heals on a backed-off
 * vendor clock; timeout/wedge expiry admits one half-open probe.
 */

import type { DatabaseProvider } from '../stores/gateway-db.js';
import type { AgentFailureClass } from './runner.js';
import type { RunnerKind } from './turn.js';

export interface RunnerHealthPolicy {
  readonly threshold: number;
  readonly cooldownMs: number;
}

export const RUNNER_HEALTH_POLICIES: Readonly<Record<AgentFailureClass, RunnerHealthPolicy>> = {
  spawn: { threshold: 2, cooldownMs: 60_000 },
  auth: { threshold: 1, cooldownMs: 0 },
  init: { threshold: 2, cooldownMs: 60_000 },
  timeout: { threshold: 2, cooldownMs: 60_000 },
  quota: { threshold: 1, cooldownMs: 2 * 60_000 },
  wedge: { threshold: 1, cooldownMs: 2 * 60_000 },
  exit: { threshold: 2, cooldownMs: 60_000 },
  unknown: { threshold: 3, cooldownMs: 60_000 },
};

export interface RunnerHealthStatus {
  readonly allowed: boolean;
  readonly breakerUntil?: number;
  readonly failureClass?: AgentFailureClass;
  readonly halfOpen?: boolean;
}

export interface RunnerHealthEntry {
  workspaceContext: string;
  runnerKind: RunnerKind;
  failureClass: AgentFailureClass;
  consecutiveFailures: number;
  state: 'closed' | 'open' | 'half-open';
  breakerUntil?: number;
  lastError?: string;
  lastFailureAt?: number;
  lastOkAt?: number;
}

export interface RunnerHealthController {
  canAttempt(workspaceContext: string, runnerKind: RunnerKind, now?: number): RunnerHealthStatus;
  reportFailure(
    workspaceContext: string,
    runnerKind: RunnerKind,
    failureClass: AgentFailureClass,
    error: string,
    now?: number,
  ): void;
  reportOk(workspaceContext: string, runnerKind: RunnerKind, now?: number): void;
  reportPreflightOk(workspaceContext: string, runnerKind: RunnerKind, now?: number): void;
  list(workspaceContext?: string, now?: number): RunnerHealthEntry[];
}

interface BreakerRow {
  workspace_context: string;
  runner_kind: RunnerKind;
  failure_class: AgentFailureClass;
  consecutive_failures: number;
  breaker_until: number | null;
  half_open_claimed_at: number | null;
  last_error: string | null;
  last_failure_at: number | null;
  last_ok_at: number | null;
}

export class RunnerHealthStore implements RunnerHealthController {
  constructor(
    private readonly dbProvider: DatabaseProvider,
    private readonly policies: Readonly<
      Record<AgentFailureClass, RunnerHealthPolicy>
    > = RUNNER_HEALTH_POLICIES,
  ) {}

  canAttempt(
    workspaceContext: string,
    runnerKind: RunnerKind,
    now = Date.now(),
  ): RunnerHealthStatus {
    const db = this.dbProvider();
    const rows = db
      .prepare(
        `SELECT workspace_context, runner_kind, failure_class, consecutive_failures,
                breaker_until, half_open_claimed_at, last_error,
                last_failure_at, last_ok_at
           FROM runner_health
          WHERE workspace_context = ? AND runner_kind = ? AND consecutive_failures > 0
          ORDER BY CASE failure_class WHEN 'auth' THEN 0 ELSE 1 END,
                   COALESCE(breaker_until, 0) DESC`,
      )
      .all(workspaceContext, runnerKind) as unknown as BreakerRow[];
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
        (row.failure_class === 'timeout' || row.failure_class === 'wedge') &&
        row.breaker_until !== null
      ) {
        const claim = db
          .prepare(
            `UPDATE runner_health
                SET half_open_claimed_at = ?
              WHERE workspace_context = ? AND runner_kind = ? AND failure_class = ?
                AND (half_open_claimed_at IS NULL OR half_open_claimed_at < ?)`,
          )
          .run(now, workspaceContext, runnerKind, row.failure_class, now - 60_000);
        return Number(claim.changes) > 0
          ? { allowed: true, failureClass: row.failure_class, halfOpen: true }
          : { allowed: false, failureClass: row.failure_class };
      }
    }
    return { allowed: true };
  }

  reportFailure(
    workspaceContext: string,
    runnerKind: RunnerKind,
    failureClass: AgentFailureClass,
    error: string,
    now = Date.now(),
  ): void {
    const policy = this.policies[failureClass];
    const db = this.dbProvider();
    const current = db
      .prepare(
        `SELECT consecutive_failures
           FROM runner_health
          WHERE workspace_context = ? AND runner_kind = ? AND failure_class = ?`,
      )
      .get(workspaceContext, runnerKind, failureClass) as
      | { consecutive_failures: number }
      | undefined;
    const count = (current?.consecutive_failures ?? 0) + 1;
    const breakerUntil =
      count < policy.threshold
        ? null
        : failureClass === 'auth'
          ? -1
          : failureClass === 'quota'
            ? now + Math.min(30 * 60_000, policy.cooldownMs * 2 ** Math.min(6, count - 1))
            : now + policy.cooldownMs;
    db.prepare(
      `INSERT INTO runner_health (
         workspace_context, runner_kind, failure_class, consecutive_failures,
         breaker_until, half_open_claimed_at, last_error, last_failure_at
       ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?)
       ON CONFLICT(workspace_context, runner_kind, failure_class) DO UPDATE SET
         consecutive_failures = excluded.consecutive_failures,
         breaker_until = excluded.breaker_until,
         half_open_claimed_at = NULL,
         last_error = excluded.last_error,
         last_failure_at = excluded.last_failure_at`,
    ).run(
      workspaceContext,
      runnerKind,
      failureClass,
      count,
      breakerUntil,
      error.slice(-4_000),
      now,
    );
  }

  reportOk(workspaceContext: string, runnerKind: RunnerKind, now = Date.now()): void {
    this.dbProvider()
      .prepare(
        `UPDATE runner_health
            SET consecutive_failures = 0, breaker_until = NULL,
                half_open_claimed_at = NULL, last_ok_at = ?
          WHERE workspace_context = ? AND runner_kind = ? AND failure_class <> 'auth'`,
      )
      .run(now, workspaceContext, runnerKind);
  }

  reportPreflightOk(workspaceContext: string, runnerKind: RunnerKind, now = Date.now()): void {
    this.dbProvider()
      .prepare(
        `UPDATE runner_health
            SET consecutive_failures = 0, breaker_until = NULL,
                half_open_claimed_at = NULL, last_ok_at = ?
          WHERE workspace_context = ? AND runner_kind = ? AND failure_class = 'auth'`,
      )
      .run(now, workspaceContext, runnerKind);
  }

  list(workspaceContext?: string, now = Date.now()): RunnerHealthEntry[] {
    const rows = this.dbProvider()
      .prepare(
        `SELECT workspace_context, runner_kind, failure_class, consecutive_failures,
                breaker_until, half_open_claimed_at, last_error,
                last_failure_at, last_ok_at
           FROM runner_health
          WHERE (? IS NULL OR workspace_context = ?)
          ORDER BY workspace_context, runner_kind, failure_class`,
      )
      .all(workspaceContext ?? null, workspaceContext ?? null) as unknown as BreakerRow[];
    return rows.map((row) => {
      const state =
        row.consecutive_failures === 0
          ? 'closed'
          : row.half_open_claimed_at !== null &&
              row.breaker_until !== null &&
              row.breaker_until !== -1 &&
              row.breaker_until <= now
            ? 'half-open'
            : 'open';
      return {
        workspaceContext: row.workspace_context,
        runnerKind: row.runner_kind,
        failureClass: row.failure_class,
        consecutiveFailures: row.consecutive_failures,
        state,
        ...(row.breaker_until !== null && row.breaker_until !== -1
          ? { breakerUntil: row.breaker_until }
          : {}),
        ...(row.last_error ? { lastError: row.last_error } : {}),
        ...(row.last_failure_at !== null ? { lastFailureAt: row.last_failure_at } : {}),
        ...(row.last_ok_at !== null ? { lastOkAt: row.last_ok_at } : {}),
      };
    });
  }
}
