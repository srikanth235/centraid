import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Registry } from './registry.js';
import type { OpenClawCron, CliCronJobDefinition } from './openclaw-cron.js';
import type { VersionStore } from './version-store.js';
import { appCodeDir } from './app-paths.js';
import type { AppId, CronModule, RegistryEntry } from '../types.js';

export interface CronSyncOptions {
  registry: Registry;
  cron: OpenClawCron;
  versions: VersionStore;
  /** Loopback URL that webhooks should target. */
  gatewayBaseUrl: string;
}

/**
 * Reconciles cron jobs declared in each registered app's `crons/` directory
 * with the OpenClaw cron registry.
 *
 * Scoping convention: every job we own has id `centraid:<app_id>:<cron_id>`.
 * That namespace is exclusively ours — anything matching that prefix in
 * OpenClaw's cron registry but not in our app folders is treated as stale
 * and removed during reconciliation.
 */
export class CronSync {
  constructor(private readonly opts: CronSyncOptions) {}

  jobIdFor(appId: AppId, cronId: string): string {
    return `centraid:${appId}:${cronId}`;
  }

  /** Resolve the active code dir for an app (uploaded → version dir; path → folder). */
  private async codeDirOf(entry: RegistryEntry): Promise<string | undefined> {
    if (entry.mode === 'uploaded') {
      const active = await this.opts.versions.getActiveVersion(entry.path);
      if (!active) return undefined;
      return appCodeDir(entry, active);
    }
    return appCodeDir(entry);
  }

  /** Read a cron module's metadata (without invoking the handler). */
  async loadAppCronModules(
    appDir: string,
  ): Promise<Array<{ cronId: string; module: CronModule; file: string }>> {
    const cronsDir = path.join(appDir, 'crons');
    let entries: string[] = [];
    try {
      entries = await fs.readdir(cronsDir);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }

    const modules: Array<{ cronId: string; module: CronModule; file: string }> = [];
    for (const name of entries) {
      if (!name.endsWith('.js') && !name.endsWith('.mjs')) continue;
      const file = path.join(cronsDir, name);
      const cronId = name.replace(/\.m?js$/, '');
      const mod = (await import(pathToFileURL(file).href)) as Partial<CronModule>;
      if (!mod.schedule || !mod.task || typeof mod.default !== 'function') {
        // Skip malformed modules — not our place to throw on user code load.
        continue;
      }
      modules.push({ cronId, module: mod as CronModule, file });
    }
    return modules;
  }

  /** Add or refresh every cron declared by a single app. */
  async syncApp(appId: AppId): Promise<void> {
    const entry = this.opts.registry.get(appId);
    if (!entry) return;

    const codeDir = await this.codeDirOf(entry);
    if (!codeDir) return; // uploaded app with no active version yet

    const modules = await this.loadAppCronModules(codeDir);

    // Remove any tokens for cron ids that no longer exist on disk.
    const declared = new Set(modules.map((m) => m.cronId));
    for (const stale of Object.keys(entry.cronTokens)) {
      if (!declared.has(stale)) {
        await this.opts.cron.removeJob(this.jobIdFor(appId, stale)).catch(() => {});
        await this.opts.registry.forgetCron(appId, stale);
      }
    }

    for (const { cronId, module } of modules) {
      const def = await this.buildJobDefinition(appId, cronId, module);
      await this.opts.cron.removeJob(def.id).catch(() => {});
      await this.opts.cron.addJob(def);
    }
  }

  /** Remove every cron belonging to an app. */
  async removeAppCrons(appId: AppId): Promise<void> {
    const entry = this.opts.registry.get(appId);
    if (!entry) return;
    for (const cronId of Object.keys(entry.cronTokens)) {
      const id = this.jobIdFor(appId, cronId);
      await this.opts.cron.removeJob(id).catch(() => {});
      await this.opts.registry.forgetCron(appId, cronId);
    }
  }

  /** Reconcile every registered app — called from `gateway_start`. */
  async syncAll(): Promise<void> {
    for (const entry of this.opts.registry.list()) {
      await this.syncApp(entry.id);
    }
  }

  private async buildJobDefinition(
    appId: AppId,
    cronId: string,
    module: CronModule,
  ): Promise<CliCronJobDefinition> {
    const id = this.jobIdFor(appId, cronId);
    const token = await this.opts.registry.mintCronToken(appId, cronId);
    const url = new URL(
      `/centraid/${encodeURIComponent(appId)}/_ingest/${encodeURIComponent(cronId)}`,
      this.opts.gatewayBaseUrl,
    ).toString();

    return {
      id,
      schedule: module.schedule,
      execution: module.execution ?? 'isolated',
      prompt: module.task.prompt,
      toolAllow: module.task.toolAllow,
      model: module.task.model,
      delivery: { mode: 'webhook', url, token },
    };
  }
}
