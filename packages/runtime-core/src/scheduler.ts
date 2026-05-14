/**
 * Transport-agnostic scheduler interface. Centraid declares cron jobs in app
 * folders (`crons/<id>.js`); a `Scheduler` implementation knows how to run
 * the LLM task on schedule and POST the result back to the runtime's ingest
 * webhook.
 *
 * The runtime never schedules anything itself — it only receives ingest
 * POSTs at `/centraid/<app>/_ingest/<cron>`. Current implementations:
 *
 *   - `OpenClawScheduler` (`@centraid/openclaw-plugin`) — talks to the
 *     `openclaw cron` CLI / SDK handle. Used when the runtime is hosted on
 *     an OpenClaw gateway.
 *   - `NullScheduler` — accepts registrations and discards them. Used by the
 *     desktop in local mode; a real local scheduler is on the backlog.
 */

export interface Scheduler {
  /** Register or refresh a cron job. Idempotent on `id`. */
  addJob(def: CronJobDefinition): Promise<void>;

  /** Remove a previously registered job by id. Idempotent. */
  removeJob(id: string): Promise<void>;

  /** Snapshot of all jobs the scheduler knows about. */
  listJobs(): Promise<CronJobSnapshot[]>;

  /** Trigger an immediate run of a registered job. */
  runJobNow(id: string): Promise<void>;
}

export interface CronJobDefinition {
  /** Globally unique id; runtime uses `centraid:<appId>:<cronId>`. */
  id: string;

  /**
   * Schedule shape. `cron` is the canonical form; `every` and `at` are
   * convenience shapes some schedulers accept directly. Implementations may
   * normalize `every`/`at` to a cron expression if their backend only
   * accepts cron.
   */
  schedule:
    | { cron: string; tz?: string; exact?: boolean }
    | { every: string }
    | { at: string; tz?: string };

  /** The LLM task the scheduler runs on schedule. */
  task: {
    prompt: string;
    toolAllow?: string[];
    model?: string;
  };

  /**
   * Where to POST the task's final result. Runtime always uses the
   * `webhook` mode; the other modes exist because the OpenClaw cron CLI
   * supports them and future schedulers may want a wider surface.
   */
  delivery:
    | { mode: 'webhook'; url: string; token: string }
    | { mode: 'announce' }
    | { mode: 'none' };

  /**
   * Execution mode hint. OpenClaw uses this to pick a session/subprocess
   * strategy; in-process schedulers can ignore it.
   */
  execution?: 'main' | 'isolated' | 'current' | { session: string };

  keepAfterRun?: boolean;
}

export interface CronJobSnapshot {
  id: string;
  name?: string;
  description?: string;
  enabled?: boolean;
  state?: {
    nextRunAtMs?: number;
    runningAtMs?: number;
    lastRunAtMs?: number;
    lastRunStatus?: 'ok' | 'error' | 'skipped';
    lastError?: string;
    lastDurationMs?: number;
  };
}

/**
 * Event the runtime forwards to the scheduler-host (e.g. OpenClaw's
 * `cron_changed` event). Captures status transitions so the runtime can
 * persist them on the per-app registry entry.
 */
export interface CronChangedEvent {
  jobId: string;
  status?: 'ok' | 'error' | 'skipped' | string;
  error?: string;
  nextRunAtMs?: number;
  job?: {
    state?: {
      lastRunAtMs?: number;
      nextRunAtMs?: number;
    };
  };
}
