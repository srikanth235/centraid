/*
 * The daemon-owned recovery JOB (issue #439 R1 wave 4) — the one genuinely new
 * piece the recovery product needs. A bare-metal restore of a hosted vault can
 * take minutes to hours, and the browser/desktop that kicked it off must be
 * free to close mid-download; the gateway daemon owns the running job, and the
 * progress SSE (`routes/recover-routes.ts`) reports it to whichever client is
 * attached. This module is the job model behind that surface: a single active
 * job, a replayable in-memory event stream, and an atomically-persisted
 * progress record so a client can reattach — or a fresh daemon can honestly
 * report a job the previous process died mid-flight.
 *
 * What it persists (atomic temp+rename, `backup-state.ts`'s exact shape): ONLY
 * progress metadata — `{jobId, state, phase, startedAt, updatedAt, targetId,
 * vaultId, error?, report?}`. NEVER the kit keyring or the provider api-key:
 * those live in memory for the running job alone and are gone the moment the
 * process ends. The consequence IS the resumability contract: survive the UI
 * closing (the daemon owns the process), report/attach from any client, and —
 * because the secrets are never on disk — a daemon that dies mid-job cannot
 * silently resume. It finds the `running` record at next startup, marks it
 * `interrupted`, cleans the torn staging dir, and the user re-submits kit+key.
 *
 * The job runs the service-layer `recover()` verb (`recover.ts`) with the live
 * gateway's own seams wired in: `onAdopted` mounts the recovered vault through
 * `VaultRegistry.adopt`, and `resolveRemoteTier` hands back the mounted plane's
 * `db.remote()` so the previews-first warm pass runs in-process and
 * `timeToUsableGridMs` lands in the report.
 */

import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { RemoteTier } from '@centraid/vault';
import {
  recover,
  type RecoverAdoptContext,
  type RecoverInput,
  type RecoverPhase,
  type RecoverReport,
} from './recover.js';
import type { ReconcileLogger } from './recover-reconcile.js';

/** The job's lifecycle. `running` is the only live state; the other three are
 *  terminal. `interrupted` is exclusively daemon-death recovery — a job the
 *  previous process was running when it exited (its in-memory secrets are gone,
 *  so it can never resume; the user re-submits kit+key). */
export type RecoverJobState = 'running' | 'done' | 'failed' | 'interrupted';

/** The persisted progress record — metadata only, NEVER kit/keyring/api-key. */
export interface RecoverJobRecord {
  jobId: string;
  state: RecoverJobState;
  /** The user-facing phase (the `recover()` phase union) the job last reached. */
  phase: RecoverPhase;
  /** Epoch ms the job started. */
  startedAt: number;
  /** Epoch ms of the last state/phase transition. */
  updatedAt: number;
  /** The provider storage-target id, once discovery names it. */
  targetId?: string;
  /** The recovered vault id, once discovery names it. */
  vaultId?: string;
  /** The failure message when `state === 'failed'`. */
  error?: string;
  /** The honest completion report when `state === 'done'` (carries no secrets). */
  report?: RecoverReport;
}

/** One event on the progress stream. Terminal events (`done`/`failed`/
 *  `interrupted`) close the SSE stream with an `event: end`. */
export type RecoverJobEvent =
  | { kind: 'phase'; phase: RecoverPhase }
  | { kind: 'done'; report: RecoverReport }
  | { kind: 'failed'; error: string }
  | { kind: 'interrupted' };

function isTerminal(ev: RecoverJobEvent): boolean {
  return ev.kind !== 'phase';
}

/* eslint-disable max-classes-per-file -- the conflict error is colocated with the one job owner it belongs to (#247) */
/** A second `/recover/start` while a job is already running (mapped to 409). */
export class RecoverJobConflictError extends Error {
  readonly code = 'recover_in_progress';
  constructor() {
    super('a recovery is already in progress on this gateway');
    this.name = 'RecoverJobConflictError';
  }
}

/** Minimal logger the job routes info/warn/error through (matches RuntimeLogger). */
export interface RecoverJobLogger {
  info(msg: string): void;
  warn(msg: string): void;
  error?(msg: string): void;
}

export interface RecoverJobDeps {
  /** Gateway-plumbing dir the progress record persists under (`recover-job.json`). */
  dir: string;
  /** Vault registry root — the recovered vault is adopted here; torn staging swept here. */
  vaultRoot: string;
  /** Backup-engine state dir — keyring + fenced target state land here. */
  backupDir: string;
  /** Mount the freshly-adopted vault (the live `VaultRegistry.adopt` seam). */
  adopt: (vaultId: string) => void;
  /** Resolve the mounted vault's remote CAS tier so the warm pass runs in-process. */
  resolveRemoteTier: (
    ctx: RecoverAdoptContext,
  ) => RemoteTier | undefined | Promise<RemoteTier | undefined>;
  logger: RecoverJobLogger;
  now?: () => number;
  /** The recovery verb — defaults to the service-layer `recover()`. Tests inject
   *  a deterministic stand-in so the job lifecycle can be driven without a real
   *  restore. */
  recoverFn?: (input: RecoverInput) => Promise<RecoverReport>;
}

/** The input a client's `/recover/start` hands the daemon — the two secrets held
 *  in memory for the running job ONLY, never persisted. */
export interface RecoverJobInput {
  kitDocument: unknown;
  apiKey: string;
}

function recordFile(dir: string): string {
  return path.join(dir, 'recover-job.json');
}

/**
 * The daemon's recovery-job owner. One instance per gateway; `init()` runs once
 * at build time to reconcile a job the previous process died mid-flight.
 */
export class RecoverJobRunner {
  private readonly now: () => number;
  private record: RecoverJobRecord | null = null;
  /** Full ordered event history for the CURRENT job — a late/reconnecting SSE
   *  subscriber replays this before going live (mirrors the run-event bus). */
  private events: RecoverJobEvent[] = [];
  private readonly subscribers = new Set<(ev: RecoverJobEvent) => void>();
  /** Serializes the atomic writes so rapid phase transitions never overlap
   *  (temp+rename races) and the last write always reflects the latest record. */
  private persistChain: Promise<void> = Promise.resolve();

  constructor(private readonly deps: RecoverJobDeps) {
    this.now = deps.now ?? Date.now;
  }

  /**
   * Reconcile any job the previous daemon process left behind. Loaded ONCE at
   * startup: a record still `running` means the process died mid-restore — its
   * in-memory kit/key are gone, so it can never resume. Mark it `interrupted`,
   * sweep the torn `.recover-staging-*` scratch, and persist. A terminal record
   * (done/failed/interrupted) is kept as-is so `/recover/status` can still
   * report the last outcome for a reattaching client.
   */
  async init(): Promise<void> {
    const loaded = await this.load();
    if (!loaded) return;
    if (loaded.state !== 'running') {
      this.record = loaded;
      return;
    }
    await this.sweepStagingDirs();
    this.record = {
      ...loaded,
      state: 'interrupted',
      updatedAt: this.now(),
    };
    // A restart resets the in-memory stream; the terminal event lets any client
    // that reattaches to this jobId see it closed rather than hang.
    this.events = [{ kind: 'interrupted' }];
    await this.persist();
    this.deps.logger.warn(
      `recover job: job ${loaded.jobId} was running when the daemon exited — marked interrupted; ` +
        'the recovery must be re-submitted with the kit and provider key',
    );
  }

  /** The current job record (or null). `/recover/status` folds the registry's
   *  `fresh` signal in around this; `/recover/events` checks the jobId against it. */
  currentRecord(): RecoverJobRecord | null {
    return this.record;
  }

  /**
   * Start a recovery job (fire-and-forget on the daemon). Refuses with a
   * `RecoverJobConflictError` (→ 409) when one is already running; every other
   * gate (freshness, the metered-egress confirm) is the route's, enforced
   * before this is called. Returns the new job id immediately — the restore
   * runs on after the client disconnects.
   */
  async start(input: RecoverJobInput): Promise<{ jobId: string }> {
    if (this.record?.state === 'running') throw new RecoverJobConflictError();
    const jobId = randomUUID();
    const startedAt = this.now();
    this.record = {
      jobId,
      state: 'running',
      phase: 'discovering',
      startedAt,
      updatedAt: startedAt,
    };
    this.events = [];
    this.subscribers.clear();
    await this.persist();
    // Fire-and-forget: the daemon owns the run; a client closing changes nothing.
    void this.run(jobId, input);
    return { jobId };
  }

  /** Subscribe to a job's live events. Returns an idempotent unsubscribe. Only
   *  the current job has a live stream; a stale jobId gets no events (the caller
   *  should replay `snapshot()` and check `currentRecord()` first). */
  subscribe(jobId: string, fn: (ev: RecoverJobEvent) => void): () => void {
    if (this.record?.jobId !== jobId) return () => undefined;
    this.subscribers.add(fn);
    return () => {
      this.subscribers.delete(fn);
    };
  }

  /** Replay the full event history for a job so a late/reconnecting subscriber
   *  sees every phase transition, not just what arrives after it connects. An
   *  unknown jobId yields nothing. */
  snapshot(jobId: string): RecoverJobEvent[] {
    return this.record?.jobId === jobId ? [...this.events] : [];
  }

  /** Live subscriber count (tests). */
  subscriberCount(): number {
    return this.subscribers.size;
  }

  /** Await all pending progress writes — the durable record is flushed. Used by
   *  tests that read the persisted file right after a job settles; a graceful
   *  daemon shutdown may await it too. */
  flush(): Promise<void> {
    return this.persistChain;
  }

  // ── internals ────────────────────────────────────────────────────────────

  private async run(jobId: string, input: RecoverJobInput): Promise<void> {
    const log: ReconcileLogger = {
      info: (m) => this.deps.logger.info(m),
      warn: (m) => this.deps.logger.warn(m),
      error: (m) => (this.deps.logger.error ?? this.deps.logger.warn)(m),
    };
    const runRecover = this.deps.recoverFn ?? recover;
    try {
      const report = await runRecover({
        kitDocument: input.kitDocument,
        apiKey: input.apiKey,
        vaultRoot: this.deps.vaultRoot,
        backupDir: this.deps.backupDir,
        now: this.now,
        log,
        onPhase: (phase) => this.onPhase(jobId, phase),
        // The live-gateway mount: adopt the recovered dir as a running vault.
        onAdopted: (ctx) => {
          this.deps.adopt(ctx.vaultId);
          // Fill the report ids in as soon as adopt names the vault, so a
          // reattaching client sees them before the run completes.
          this.patch(jobId, { vaultId: ctx.vaultId, targetId: ctx.targetId });
        },
        // After mount the plane's own remote CAS tier warms previews in-process.
        resolveRemoteTier: this.deps.resolveRemoteTier,
      });
      this.settle(jobId, {
        state: 'done',
        phase: 'done',
        report,
        vaultId: report.vaultId,
        targetId: report.targetId,
      });
      this.emit(jobId, { kind: 'done', report });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.deps.logger.warn(`recover job: job ${jobId} failed: ${error}`);
      this.settle(jobId, { state: 'failed', error });
      this.emit(jobId, { kind: 'failed', error });
    }
  }

  private onPhase(jobId: string, phase: RecoverPhase): void {
    if (this.record?.jobId !== jobId) return;
    this.record = { ...this.record, phase, updatedAt: this.now() };
    void this.persist();
    this.emit(jobId, { kind: 'phase', phase });
  }

  /** Merge fields into the running record without moving its state/phase. */
  private patch(jobId: string, patch: Partial<RecoverJobRecord>): void {
    if (this.record?.jobId !== jobId) return;
    this.record = { ...this.record, ...patch, updatedAt: this.now() };
    void this.persist();
  }

  /** Move the record to a terminal state and persist (secrets never touched). */
  private settle(jobId: string, patch: Partial<RecoverJobRecord>): void {
    if (this.record?.jobId !== jobId) return;
    this.record = { ...this.record, ...patch, updatedAt: this.now() };
    void this.persist();
  }

  private emit(jobId: string, ev: RecoverJobEvent): void {
    if (this.record?.jobId !== jobId) return;
    this.events.push(ev);
    for (const fn of Array.from(this.subscribers)) {
      try {
        fn(ev);
      } catch {
        /* one wedged subscriber must not break the fanout */
      }
    }
    // Terminal: drop subscribers so the stream owners close and the next job
    // starts clean.
    if (isTerminal(ev)) this.subscribers.clear();
  }

  private async load(): Promise<RecoverJobRecord | null> {
    try {
      const raw = await fs.readFile(recordFile(this.deps.dir), 'utf8');
      return JSON.parse(raw) as RecoverJobRecord;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      return null;
    }
  }

  /**
   * Persist the current record atomically (temp+rename, `backup-state.ts`'s
   * shape). Serialized through `persistChain` so overlapping calls can't reorder
   * or collide. A write failure is LOGGED, not thrown: the in-memory record is
   * authoritative for the live SSE, and a transient disk hiccup persisting
   * progress metadata must never crash the daemon or reject unhandled. Returns
   * the chain tail so `init`/`start` can await a durable write.
   */
  private persist(): Promise<void> {
    this.persistChain = this.persistChain.then(async () => {
      const record = this.record;
      if (!record) return;
      try {
        await fs.mkdir(this.deps.dir, { recursive: true });
        const file = recordFile(this.deps.dir);
        const tmp = `${file}.${process.pid}.${this.now()}.tmp`;
        await fs.writeFile(tmp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
        await fs.rename(tmp, file);
      } catch (err) {
        this.deps.logger.warn(
          `recover job: could not persist progress: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    });
    return this.persistChain;
  }

  /** Sweep any torn `.recover-staging-*` scratch the crashed run left under the
   *  vault root (the naming `recover()` stages under). Best-effort — a leftover
   *  dir is dead scratch, never a mounted vault (the dot-prefix keeps the
   *  registry from mounting it). */
  private async sweepStagingDirs(): Promise<void> {
    if (!existsSync(this.deps.vaultRoot)) return;
    let entries: string[];
    try {
      entries = await fs.readdir(this.deps.vaultRoot);
    } catch {
      return;
    }
    for (const name of entries) {
      if (!name.startsWith('.recover-staging-')) continue;
      await fs
        .rm(path.join(this.deps.vaultRoot, name), { recursive: true, force: true })
        .catch(() => undefined);
      this.deps.logger.info(`recover job: swept torn staging scratch ${name}`);
    }
  }
}
