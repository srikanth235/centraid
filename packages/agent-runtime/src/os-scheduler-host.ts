/**
 * AutomationHost adapter on top of `os-scheduler.ts`.
 *
 * `os-scheduler.ts` knows nothing about `AutomationRow` — it speaks
 * `OsSchedulerJobSpec` (cron + cwd + runner + bin path). This adapter
 * bridges the two so the desktop's IPC handlers (and any future
 * caller wanting register/unregister semantics) can talk to a single
 * `AutomationHost` interface that openclaw also implements.
 *
 * Disabled rows: OS schedulers don't have a "registered but
 * suppressed" state — launchd, systemd, and Task Scheduler are
 * binary. So when `register` is called with `row.enabled === false`,
 * the host unregisters instead. Callers don't need to special-case
 * this; just call `register(row)` whenever a row changes.
 */

import type {
  AutomationHost,
  AutomationReconcileOptions,
  AutomationReconcileResult,
  AutomationRow,
} from '@centraid/runtime-core';
import {
  jobLabel,
  list as listOsJobs,
  reconcile as reconcileOsJobs,
  register as registerOsJob,
  unregister as unregisterOsJob,
  type OsSchedulerJobSpec,
  type OsSchedulerOptions,
  type OsSchedulerReconcileDesired,
} from './os-scheduler.js';
import type { LocalRunnerKind } from './run-automation-local.js';

export interface OsSchedulerHostOptions {
  /**
   * Resolve the persistent app root for a given app id. Returned
   * path is baked into the OS scheduler artifact at register time
   * (launchd `WorkingDirectory`, systemd `WorkingDirectory`); must
   * be stable across publishes — the CLI's `run-automation`
   * re-resolves the active version inside that root each fire.
   */
  resolveAppDir(appId: string): string;
  /** Absolute path to the `centraid` binary the scheduler should invoke. */
  centraidBin: string;
  /** Which CLI runner to drive (codex / claude-code). */
  runner: LocalRunnerKind;
  /** Options forwarded to os-scheduler (mostly used in tests for execShell + artifactRoot overrides). */
  os?: OsSchedulerOptions;
}

export class OsSchedulerHost implements AutomationHost {
  constructor(private readonly opts: OsSchedulerHostOptions) {}

  async register(row: AutomationRow): Promise<void> {
    // OS schedulers don't distinguish "disabled" from "absent" —
    // collapse disabled to unregister so reconcile and toggle stay
    // consistent.
    if (!row.enabled) {
      await this.unregister(row.appId, row.name);
      return;
    }
    await registerOsJob(this.specFor(row), this.opts.os);
  }

  async unregister(appId: string, name: string): Promise<void> {
    await unregisterOsJob(appId, name, this.opts.os);
  }

  async list(): Promise<readonly string[]> {
    const installed = await listOsJobs(this.opts.os);
    return installed.map((e) => jobLabel(e.appId, e.automationName));
  }

  async reconcile(
    desired: ReadonlyArray<AutomationRow>,
    opts: AutomationReconcileOptions = {},
  ): Promise<AutomationReconcileResult> {
    const items: OsSchedulerReconcileDesired[] = desired.map((row) => ({
      spec: this.specFor(row),
      enabled: row.enabled,
    }));
    const out = await reconcileOsJobs(items, this.opts.os, opts.scope);
    return {
      added: out.added,
      updated: out.updated,
      removed: out.removed,
    };
  }

  private specFor(row: AutomationRow): OsSchedulerJobSpec {
    return {
      appId: row.appId,
      automationName: row.name,
      cronExpr: row.cronExpr,
      cwd: this.opts.resolveAppDir(row.appId),
      runner: this.opts.runner,
      centraidBin: this.opts.centraidBin,
    };
  }
}
