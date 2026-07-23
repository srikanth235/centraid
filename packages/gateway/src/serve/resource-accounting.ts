/*
 * Per-subsystem resource ACTUALS — the honest counterpart to the resolved
 * Resource profile (#528 Phase A/B, which says what the gateway is ALLOWED
 * to spend). This records what each background subsystem actually did:
 * replication passes and bytes, backup drains and bytes, vault + outbox
 * sweep passes, worker-pool tasks, and agent runs — each with the
 * wall-clock it occupied.
 *
 * Design constraints (issue #528 Phase C):
 *   - MEASURED PROXIES ONLY. Never a fabricated watt or a synthesized
 *     energy figure — the fields are counts, byte totals, wall-clock ms,
 *     and the OS-reported process CPU/RSS. `agentRuns.cpuSeconds` stays
 *     `null`: Node cannot cheaply read a child process's rusage across
 *     platforms, so we do not guess it.
 *   - AGENT RUNS ARE ACCOUNTED, NEVER THROTTLED. This class only counts;
 *     nothing here gates or defers a run.
 *   - NEGLIGIBLE OVERHEAD. No timers of its own. CPU/RSS are read lazily
 *     inside `snapshot()` (at the health-poll cadence) and at each
 *     subsystem-completion hook — never on a hot path. The rolling-hour
 *     window is a small timestamp array pruned on record/read.
 *
 * Pure and gateway-free: the clock, the CPU reader, and the RSS reader are
 * all injectable, so this is unit-testable with a fake clock and no process
 * state. `build-gateway.ts` constructs one at boot, wires the record* hooks
 * through the vault registry / backup service / worker admission / agent
 * runners, and publishes `snapshot()` on the health metrics source.
 */

/** Rolling window for `backgroundTimerFiresLastHour`. */
const HOUR_MS = 60 * 60 * 1000;

/**
 * Measured per-subsystem resource actuals, published as
 * `metrics.resourceUsage` on the gateway health snapshot (#528 Phase C).
 * Every field is an OS- or code-measured number — no modeled energy.
 */
export interface ResourceUsageActuals {
  /** epoch ms when accounting started (gateway boot) */
  sinceMs: number;
  process: {
    /** process-wide user+system CPU seconds since boot (process.cpuUsage) */
    cpuSecondsTotal: number;
    currentRssBytes: number;
    /** max rss observed at sample points (snapshot reads + subsystem completions) */
    peakRssBytes: number;
  };
  subsystems: {
    workerPool: { tasks: number; busyMs: number };
    replication: { passes: number; bytesReplicated: number; busyMs: number };
    backup: { drains: number; bytesUploaded: number; busyMs: number };
    sweeps: { passes: number; busyMs: number };
    agentRuns: { runs: number; busyMs: number; cpuSeconds: number | null };
  };
  /** count of background timer fires (sweep/outbox/backup scheduler ticks) in the last rolling hour, or null before first window */
  backgroundTimerFiresLastHour: number | null;
}

/** Live worker-pool cumulative counters, read at snapshot time (source: `WorkerAdmission`). */
export interface WorkerPoolActuals {
  tasks: number;
  busyMs: number;
}

export interface ResourceAccountingOptions {
  /** Wall clock (ms). Injected in tests; defaults to `Date.now`. */
  now?: () => number;
  /** Process CPU reader; defaults to `process.cpuUsage` (microseconds since boot). */
  cpuUsage?: () => { user: number; system: number };
  /** Resident-set-size reader (bytes); defaults to `process.memoryUsage().rss`. */
  rss?: () => number;
  /**
   * Live worker-pool counters. The worker pool tracks its own cumulative
   * `tasks`/`busyMs` (issue #351 admission gate lives in app-engine, which
   * must not depend on the gateway), so the gateway reads them here at
   * snapshot time rather than pushing a per-task hook across the boundary.
   */
  workerPoolStats?: () => WorkerPoolActuals;
}

interface SubsystemBusy {
  passes: number;
  busyMs: number;
}

/**
 * Accumulates per-subsystem actuals. All `record*` methods are cheap
 * counter bumps plus one RSS sample; `snapshot()` reads CPU/RSS once and
 * assembles the DTO. Every method tolerates being called from a detached
 * promise — nothing here throws or awaits.
 */
export class ResourceAccounting {
  private readonly now: () => number;
  private readonly cpuUsage: () => { user: number; system: number };
  private readonly rss: () => number;
  private readonly workerPoolStats: () => WorkerPoolActuals;

  private readonly sinceMs: number;
  private peakRssBytes = 0;

  private readonly sweeps: SubsystemBusy = { passes: 0, busyMs: 0 };
  private replicationPasses = 0;
  private replicationBytes = 0;
  private replicationBusyMs = 0;
  private backupDrains = 0;
  private backupBytesUploaded = 0;
  private backupBusyMs = 0;
  private agentRuns = 0;
  private agentBusyMs = 0;

  /** Epoch-ms timestamps of background timer fires; pruned to the last hour. */
  private readonly timerFires: number[] = [];

  constructor(options: ResourceAccountingOptions = {}) {
    this.now = options.now ?? Date.now;
    this.cpuUsage = options.cpuUsage ?? (() => process.cpuUsage());
    this.rss = options.rss ?? (() => process.memoryUsage().rss);
    this.workerPoolStats = options.workerPoolStats ?? (() => ({ tasks: 0, busyMs: 0 }));
    this.sinceMs = this.now();
    this.sampleRss();
  }

  /** One blob-replication sweep completed on a vault plane. */
  recordReplicationPass(info: { bytesReplicated: number; durationMs: number }): void {
    this.replicationPasses += 1;
    this.replicationBytes += Math.max(0, info.bytesReplicated);
    this.replicationBusyMs += Math.max(0, info.durationMs);
    this.sampleRss();
  }

  /** One backup WAL drain completed (per vault, per pass). */
  recordBackupDrain(info: { bytesUploaded: number; durationMs: number }): void {
    this.backupDrains += 1;
    this.backupBytesUploaded += Math.max(0, info.bytesUploaded);
    this.backupBusyMs += Math.max(0, info.durationMs);
    this.sampleRss();
  }

  /** One vault-plane lifecycle sweep OR one outbox sweep pass completed. */
  recordSweepPass(info: { durationMs: number }): void {
    this.sweeps.passes += 1;
    this.sweeps.busyMs += Math.max(0, info.durationMs);
    this.sampleRss();
  }

  /**
   * One agent run finished (chat/builder/ask turn). `durationMs` is
   * wall-clock spawn→exit. Recorded on both success and failure — the host
   * consumed the wall-clock either way (the honest proxy). Never throttled.
   */
  recordAgentRun(info: { durationMs: number }): void {
    this.agentRuns += 1;
    this.agentBusyMs += Math.max(0, info.durationMs);
    this.sampleRss();
  }

  /** A background scheduler tick fired (vault sweep / outbox / backup clock). */
  recordBackgroundTimerFire(): void {
    this.timerFires.push(this.now());
    this.pruneTimerFires();
  }

  snapshot(): ResourceUsageActuals {
    const rss = this.sampleRss();
    const cpu = this.cpuUsage();
    const worker = this.workerPoolStats();
    return {
      sinceMs: this.sinceMs,
      process: {
        cpuSecondsTotal: (cpu.user + cpu.system) / 1_000_000,
        currentRssBytes: rss,
        peakRssBytes: this.peakRssBytes,
      },
      subsystems: {
        workerPool: { tasks: worker.tasks, busyMs: worker.busyMs },
        replication: {
          passes: this.replicationPasses,
          bytesReplicated: this.replicationBytes,
          busyMs: this.replicationBusyMs,
        },
        backup: {
          drains: this.backupDrains,
          bytesUploaded: this.backupBytesUploaded,
          busyMs: this.backupBusyMs,
        },
        sweeps: { passes: this.sweeps.passes, busyMs: this.sweeps.busyMs },
        agentRuns: {
          runs: this.agentRuns,
          busyMs: this.agentBusyMs,
          // Intentionally null in v1: no cheap cross-platform child rusage.
          cpuSeconds: null,
        },
      },
      backgroundTimerFiresLastHour: this.backgroundTimerFires(),
    };
  }

  /** Sample RSS and advance the peak; returns the current reading. */
  private sampleRss(): number {
    const rss = this.rss();
    if (rss > this.peakRssBytes) this.peakRssBytes = rss;
    return rss;
  }

  /**
   * Null until a full hour has elapsed since boot — a rolling-hour figure
   * is not yet meaningful before its first complete window. After that, the
   * count of fires within the last hour.
   */
  private backgroundTimerFires(): number | null {
    const now = this.now();
    if (now - this.sinceMs < HOUR_MS) return null;
    this.pruneTimerFires();
    return this.timerFires.length;
  }

  private pruneTimerFires(): void {
    const cutoff = this.now() - HOUR_MS;
    let drop = 0;
    while (drop < this.timerFires.length && this.timerFires[drop]! <= cutoff) drop += 1;
    if (drop > 0) this.timerFires.splice(0, drop);
  }
}
