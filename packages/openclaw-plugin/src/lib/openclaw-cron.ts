import { spawn } from 'node:child_process';
import type { Scheduler, CronJobDefinition, CronJobSnapshot } from '@centraid/runtime-core';

/**
 * Structural shape of the cron service exposed via `ctx.getCron?.()` in
 * `gateway_start` and `cron_changed` hooks. Mirrors the SDK's internal
 * `PluginHookGatewayCronService` type, which isn't promoted in any of
 * `openclaw/plugin-sdk`'s public subpath re-exports as of openclaw
 * 2026.5.7. Defined here because this is the only file that names it.
 *
 * Note: this surface doesn't accept webhook delivery, tool allowlists, or
 * model overrides — for those we drop down to the CLI (Path B).
 */
export interface CronService {
  list(opts?: { includeDisabled?: boolean }): Promise<CronJobSnapshot[]>;
  add(input: CronCreateInput): Promise<unknown>;
  update(id: string, patch: Partial<CronCreateInput>): Promise<unknown>;
  remove(id: string): Promise<{ removed?: boolean }>;
}

export interface CronCreateInput {
  name: string;
  description: string;
  enabled: boolean;
  schedule: { kind: string; expr: string; tz?: string };
  sessionTarget: string;
  wakeMode: string;
  payload: { kind: string; text?: string };
}

/**
 * `Scheduler` implementation that talks to OpenClaw's cron registry.
 *
 * **Path B (default):** shells out to the documented `openclaw cron` CLI.
 * This is the only path that supports webhook delivery, tool allowlists,
 * and model overrides — features the centraid cron → ingest round-trip
 * depends on.
 *
 * **Path A (opt-in):** uses `ctx.getCron?.()` from `gateway_start`. The
 * SDK's `PluginHookGatewayCronService` shape is narrower than the CLI —
 * no webhook delivery — so Path A is currently used only for `list` and
 * `remove`, with `add` delegating to Path B even when a handle is present.
 */
export class OpenClawScheduler implements Scheduler {
  constructor(
    private readonly opts: {
      cliBin?: string;
      handle?: CronService | undefined;
    } = {},
  ) {}

  private get cli(): string {
    return this.opts.cliBin ?? 'openclaw';
  }

  /**
   * `addJob` always uses CLI — the public cron handle doesn't accept webhook
   * delivery, which centraid's design depends on.
   */
  async addJob(def: CronJobDefinition): Promise<void> {
    await this.cliAdd(def);
  }

  async removeJob(id: string): Promise<void> {
    if (this.opts.handle) {
      await this.opts.handle.remove(id).catch(() => undefined);
      return;
    }
    await this.runCli(['cron', 'remove', '--id', id]);
  }

  async listJobs(): Promise<CronJobSnapshot[]> {
    if (this.opts.handle) {
      return await this.opts.handle.list();
    }
    const out = await this.runCli(['cron', 'list', '--json']);
    try {
      const parsed: unknown = JSON.parse(out.stdout || '[]');
      if (!Array.isArray(parsed)) return [];
      return parsed as CronJobSnapshot[];
    } catch {
      return [];
    }
  }

  async runJobNow(id: string): Promise<void> {
    await this.runCli(['cron', 'run', id]);
  }

  /** Translate a CronJobDefinition into `openclaw cron add` flags. */
  private async cliAdd(def: CronJobDefinition): Promise<void> {
    const args: string[] = ['cron', 'add', '--id', def.id, '--prompt', def.task.prompt];

    if ('cron' in def.schedule) {
      args.push('--cron', def.schedule.cron);
      if (def.schedule.tz) args.push('--tz', def.schedule.tz);
      if (def.schedule.exact) args.push('--exact');
    } else if ('every' in def.schedule) {
      args.push('--every', def.schedule.every);
    } else if ('at' in def.schedule) {
      args.push('--at', def.schedule.at);
      if (def.schedule.tz) args.push('--tz', def.schedule.tz);
    }

    if (typeof def.execution === 'string') {
      args.push('--execution', def.execution);
    } else if (def.execution && 'session' in def.execution) {
      args.push('--execution', `session:${def.execution.session}`);
    }

    if (def.task.toolAllow && def.task.toolAllow.length > 0) {
      args.push('--tool-allow', def.task.toolAllow.join(','));
    }

    if (def.task.model) args.push('--model', def.task.model);
    if (def.keepAfterRun) args.push('--keep-after-run');

    if (def.delivery.mode === 'webhook') {
      args.push('--webhook', def.delivery.url, '--webhook-token', def.delivery.token);
    } else if (def.delivery.mode === 'announce') {
      args.push('--announce');
    } else if (def.delivery.mode === 'none') {
      args.push('--no-deliver');
    }

    await this.runCli(args);
  }

  private runCli(args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.cli, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (c: Buffer) => (stdout += c.toString('utf8')));
      child.stderr.on('data', (c: Buffer) => (stderr += c.toString('utf8')));
      child.on('error', reject);
      child.on('close', (code) => {
        if (code === 0) resolve({ stdout, stderr, code });
        else reject(new OpenClawCliError(this.cli, args, code ?? -1, stderr));
      });
    });
  }
}

// eslint-disable-next-line max-classes-per-file -- error class is colocated with its module
export class OpenClawCliError extends Error {
  constructor(
    public readonly bin: string,
    public readonly args: string[],
    public readonly exitCode: number,
    public readonly stderr: string,
  ) {
    super(`${bin} ${args.join(' ')} exited with code ${exitCode}: ${stderr.trim()}`);
    this.name = 'OpenClawCliError';
  }
}
