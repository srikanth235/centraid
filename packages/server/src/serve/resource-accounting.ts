/*
 * Measured resource actuals (#528). Binding: proxies only — counts, bytes,
 * wall-clock, OS CPU/RSS, never a modeled watt; counts but never throttles;
 * no timers of its own and no sampling on a hot path.
 */

const HOUR_MS = 60 * 60 * 1000;

export interface ResourceUsageActuals {
  sinceMs: number;
  process: {
    cpuSecondsTotal: number;
    currentRssBytes: number;
    peakRssBytes: number;
  };
  subsystems: {
    workerPool: { tasks: number; busyMs: number };
    replication: { passes: number; bytesReplicated: number; busyMs: number };
    backup: { drains: number; bytesUploaded: number; busyMs: number };
    sweeps: { passes: number; busyMs: number };
    harnessRuns: { runs: number; busyMs: number; cpuSeconds: number | null };
  };
  /** Null until the first full rolling hour has elapsed. */
  backgroundTimerFiresLastHour: number | null;
}

export interface WorkerPoolActuals {
  tasks: number;
  busyMs: number;
}

export interface ResourceAccountingOptions {
  now?: () => number;
  cpuUsage?: () => { user: number; system: number };
  rss?: () => number;
  /** Pulled, not pushed: the #351 admission gate must not depend on the gateway. */
  workerPoolStats?: () => WorkerPoolActuals;
}

interface SubsystemBusy {
  passes: number;
  busyMs: number;
}

/** Every method must stay non-throwing: callers invoke them from detached promises. */
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
  private harnessRuns = 0;
  private harnessBusyMs = 0;

  private readonly timerFires: number[] = [];

  constructor(options: ResourceAccountingOptions = {}) {
    this.now = options.now ?? Date.now;
    this.cpuUsage = options.cpuUsage ?? (() => process.cpuUsage());
    this.rss = options.rss ?? (() => process.memoryUsage().rss);
    this.workerPoolStats =
      options.workerPoolStats ?? (() => ({ tasks: 0, busyMs: 0 }));
    this.sinceMs = this.now();
    this.sampleRss();
  }

  recordReplicationPass(info: {
    bytesReplicated: number;
    durationMs: number;
  }): void {
    this.replicationPasses += 1;
    this.replicationBytes += Math.max(0, info.bytesReplicated);
    this.replicationBusyMs += Math.max(0, info.durationMs);
    this.sampleRss();
  }

  recordBackupDrain(info: { bytesUploaded: number; durationMs: number }): void {
    this.backupDrains += 1;
    this.backupBytesUploaded += Math.max(0, info.bytesUploaded);
    this.backupBusyMs += Math.max(0, info.durationMs);
    this.sampleRss();
  }

  recordSweepPass(info: { durationMs: number }): void {
    this.sweeps.passes += 1;
    this.sweeps.busyMs += Math.max(0, info.durationMs);
    this.sampleRss();
  }

  /** Record on failure too: the host spent the wall-clock either way. */
  recordHarnessRun(info: { durationMs: number }): void {
    this.harnessRuns += 1;
    this.harnessBusyMs += Math.max(0, info.durationMs);
    this.sampleRss();
  }

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
        harnessRuns: {
          runs: this.harnessRuns,
          busyMs: this.harnessBusyMs,
          // Stays null: no cheap cross-platform child rusage to measure.
          cpuSeconds: null,
        },
      },
      backgroundTimerFiresLastHour: this.backgroundTimerFires(),
    };
  }

  private sampleRss(): number {
    const rss = this.rss();
    if (rss > this.peakRssBytes) this.peakRssBytes = rss;
    return rss;
  }

  private backgroundTimerFires(): number | null {
    const now = this.now();
    if (now - this.sinceMs < HOUR_MS) return null;
    this.pruneTimerFires();
    return this.timerFires.length;
  }

  private pruneTimerFires(): void {
    const cutoff = this.now() - HOUR_MS;
    let drop = 0;
    while (drop < this.timerFires.length && this.timerFires[drop]! <= cutoff)
      drop += 1;
    if (drop > 0) this.timerFires.splice(0, drop);
  }
}
