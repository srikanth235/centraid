/**
 * AutomationHost adapter on top of `os-scheduler.ts`.
 *
 * `os-scheduler.ts` knows nothing about `AutomationRow` — it speaks
 * `OsSchedulerJobSpec` (automation id + cron + cwd + runner + bin
 * path). This adapter bridges the two so the desktop's IPC handlers
 * can talk to a single `AutomationHost` interface that openclaw also
 * implements.
 *
 * Issue #98: an automation is identified by its `<appId>/<id>` handle;
 * the OS scheduler job label is `com.centraid.<slug>` (the handle run
 * through `automationSlug`). The job's working directory is a stable
 * workspace dir — the CLI resolves the automation from `appsDir`.
 *
 * Disabled rows: OS schedulers don't have a "registered but suppressed"
 * state — launchd, systemd, and Task Scheduler are binary. So when
 * `register` is called with `row.enabled === false`, the host
 * unregisters instead.
 *
 * Trigger fan-out (issue #96): a row carries a plural `triggers` list.
 * This host registers only the `cron` triggers; `webhook` triggers are
 * skipped (the desktop is a gateway *client*, not an HTTP host). A row
 * whose triggers are all webhooks — or which has no triggers at all —
 * registers nothing and is treated like a disabled row.
 */

import {
  cronTriggersOf,
  type AutomationHost,
  type AutomationReconcileResult,
  type AutomationRow,
} from '@centraid/runtime-core';
import {
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
   * Working directory baked into the OS scheduler artifact. Any stable
   * workspace dir — model-B automations load their manifest from the
   * activity DB by id, not from a path under this dir.
   */
  workdir: string;
  /** Absolute path to the `centraid` binary the scheduler should invoke. */
  centraidBin: string;
  /**
   * Absolute path to the central analytics DB
   * (`centraid-analytics.sqlite`). Baked into the OS scheduler artifact
   * as `CENTRAID_ANALYTICS_DB` so the scheduled `centraid
   * run-automation` write-throughs its run summary to the SAME DB the
   * desktop Insights screen reads (issue #98).
   */
  analyticsDbPath: string;
  /**
   * Directory holding the app folders (issue #98). Baked into the
   * artifact as `CENTRAID_APPS_DIR` so the scheduled `centraid
   * run-automation` resolves the automation off the same disk tree the
   * desktop scaffolds into.
   */
  appsDir: string;
  /** Which CLI runner to drive (codex / claude-code). */
  runner: LocalRunnerKind;
  /** Options forwarded to os-scheduler (mostly tests: execShell + artifactRoot overrides). */
  os?: OsSchedulerOptions;
}

export class OsSchedulerHost implements AutomationHost {
  constructor(private readonly opts: OsSchedulerHostOptions) {}

  async register(row: AutomationRow): Promise<void> {
    // OS schedulers don't distinguish "disabled" from "absent" —
    // collapse disabled (and webhook-only) rows to unregister so
    // reconcile and toggle stay consistent.
    const spec = this.specFor(row);
    if (!row.enabled || !spec) {
      await this.unregister(row.ref);
      return;
    }
    await registerOsJob(spec, this.opts.os);
  }

  async unregister(automationId: string): Promise<void> {
    await unregisterOsJob(automationId, this.opts.os);
  }

  async list(): Promise<readonly string[]> {
    const installed = await listOsJobs(this.opts.os);
    return installed.map((e) => e.automationId);
  }

  async reconcile(desired: ReadonlyArray<AutomationRow>): Promise<AutomationReconcileResult> {
    const items: OsSchedulerReconcileDesired[] = [];
    for (const row of desired) {
      const cronExprs = cronTriggersOf(row.triggers).map((t) => t.expr);
      // A webhook-only row has no cron schedule — fold it into the
      // desired set as disabled so reconcile removes any stale OS job.
      items.push({
        spec: this.buildSpec(row, cronExprs),
        enabled: row.enabled && cronExprs.length > 0,
      });
    }
    const out = await reconcileOsJobs(items, this.opts.os);
    return { added: out.added, updated: out.updated, removed: out.removed };
  }

  /**
   * Build the OS scheduler spec for a row's cron triggers. Returns
   * `undefined` when the row has no cron trigger (webhook-only) — there
   * is nothing for the OS scheduler to register.
   */
  private specFor(row: AutomationRow): OsSchedulerJobSpec | undefined {
    const cronExprs = cronTriggersOf(row.triggers).map((t) => t.expr);
    if (cronExprs.length === 0) return undefined;
    return this.buildSpec(row, cronExprs);
  }

  private buildSpec(row: AutomationRow, cronExprs: readonly string[]): OsSchedulerJobSpec {
    return {
      automationId: row.ref,
      automationName: row.name,
      cronExprs,
      cwd: this.opts.workdir,
      runner: this.opts.runner,
      centraidBin: this.opts.centraidBin,
      env: {
        CENTRAID_ANALYTICS_DB: this.opts.analyticsDbPath,
        CENTRAID_APPS_DIR: this.opts.appsDir,
      },
    };
  }
}
