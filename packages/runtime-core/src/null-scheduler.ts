import type { Scheduler, CronJobDefinition, CronJobSnapshot } from './scheduler.js';

/**
 * A no-op `Scheduler`. Accepts cron registrations and discards them — crons
 * are never fired. Local query/action handlers work unchanged; only the
 * cron-fed ingest path is dark.
 *
 * Used as the default scheduler when the desktop runs in local mode. Cron
 * execution for the embedded runtime is on the backlog; until a real local
 * scheduler ships, registered jobs are silently discarded. Logs a one-shot
 * warning on first use so the absence is discoverable.
 */
export class NullScheduler implements Scheduler {
  private warned = false;
  constructor(private readonly logger?: { warn(message: string): void }) {}

  private warnOnce(): void {
    if (this.warned) return;
    this.warned = true;
    this.logger?.warn(
      '[centraid] no scheduler is wired — cron jobs registered by apps will not run in local mode. ' +
        'Connect to a remote OpenClaw gateway for scheduled cron execution.',
    );
  }

  async addJob(_def: CronJobDefinition): Promise<void> {
    this.warnOnce();
  }

  async removeJob(_id: string): Promise<void> {
    // no-op
  }

  async listJobs(): Promise<CronJobSnapshot[]> {
    return [];
  }

  async runJobNow(_id: string): Promise<void> {
    this.warnOnce();
  }
}
