/*
 * Process-wide performance signals for the gateway (issue #456 M2).
 *
 * `monitorEventLoopDelay` is the one measurement that sees every source of
 * synchronous work on Node's single event loop, including `node:sqlite` and
 * native addons. The monitor keeps one short rolling window for runtime load
 * shedding and a process-lifetime peak for benchmark/diagnostic evidence.
 */

import { monitorEventLoopDelay } from 'node:perf_hooks';

const NS_PER_MS = 1_000_000;

export interface GatewayPerformanceSnapshot {
  eventLoopLagP50Ms: number;
  eventLoopLagP99Ms: number;
  eventLoopLagMaxMs: number;
  eventLoopLagPeakP99Ms: number;
  eventLoopLagSamples: number;
  storageFsyncMs?: number;
}

interface EventLoopDelayHistogramLike {
  readonly count: number;
  readonly max: number;
  enable(): boolean;
  disable(): boolean;
  reset(): void;
  percentile(percentile: number): number;
}

export interface GatewayPerformanceMonitorOptions {
  /** Native histogram resolution. Twenty milliseconds keeps a 50 ms shed threshold meaningful. */
  resolutionMs?: number;
  /** Active sampling window. Set to zero only in deterministic unit tests. */
  sampleWindowMs?: number;
  /** Snapshot cadence. Collection remains enabled between snapshots. */
  sampleIntervalMs?: number;
  histogram?: EventLoopDelayHistogramLike;
  storageFsyncMs?: number;
}

const EMPTY_WINDOW = {
  eventLoopLagP50Ms: 0,
  eventLoopLagP99Ms: 0,
  eventLoopLagMaxMs: 0,
  eventLoopLagSamples: 0,
};

function milliseconds(nanoseconds: number): number {
  if (!Number.isFinite(nanoseconds) || nanoseconds < 0) return 0;
  return nanoseconds / NS_PER_MS;
}

/** One global monitor shared by health, benchmarks, and background load shedding. */
export class GatewayPerformanceMonitor {
  private readonly histogram: EventLoopDelayHistogramLike;
  private timer?: NodeJS.Timeout;
  private readonly sampleIntervalMs: number;
  private lastWindow = { ...EMPTY_WINDOW };
  private peakP99Ms = 0;
  private storageFsyncMs?: number;
  private closed = false;

  constructor(options: GatewayPerformanceMonitorOptions = {}) {
    this.histogram =
      options.histogram ?? monitorEventLoopDelay({ resolution: options.resolutionMs ?? 20 });
    this.storageFsyncMs = options.storageFsyncMs;
    const firstWindowMs = options.sampleWindowMs ?? 1_000;
    this.sampleIntervalMs = Math.max(1, options.sampleIntervalMs ?? firstWindowMs);
    this.histogram.enable();
    if (firstWindowMs > 0) this.scheduleWindowEnd(firstWindowMs);
  }

  setStorageFsyncMs(value: number): void {
    this.storageFsyncMs = value;
  }

  snapshot(): GatewayPerformanceSnapshot {
    const current = this.readWindow();
    const signal = current.eventLoopLagSamples > 0 ? current : this.lastWindow;
    this.peakP99Ms = Math.max(this.peakP99Ms, signal.eventLoopLagP99Ms);
    return {
      ...signal,
      eventLoopLagPeakP99Ms: this.peakP99Ms,
      ...(this.storageFsyncMs !== undefined ? { storageFsyncMs: this.storageFsyncMs } : {}),
    };
  }

  shouldDeferBackgroundWork(maxP99Ms = 50): boolean {
    return this.snapshot().eventLoopLagP99Ms >= maxP99Ms;
  }

  /** Begin a fresh measurement epoch after boot/warmup (benchmark seam). */
  resetMeasurement(): void {
    this.lastWindow = { ...EMPTY_WINDOW };
    this.peakP99Ms = 0;
    this.histogram.reset();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.histogram.disable();
  }

  private finishWindow(): void {
    if (this.closed) return;
    const next = this.readWindow();
    if (next.eventLoopLagSamples > 0) {
      this.lastWindow = next;
      this.peakP99Ms = Math.max(this.peakP99Ms, next.eventLoopLagP99Ms);
    }
    this.histogram.reset();
    this.scheduleWindowEnd(this.sampleIntervalMs);
  }

  private scheduleWindowEnd(delayMs: number): void {
    this.timer = setTimeout(() => this.finishWindow(), delayMs);
    this.timer.unref();
  }

  private readWindow(): typeof EMPTY_WINDOW {
    const count = Number(this.histogram.count);
    if (!Number.isFinite(count) || count <= 0) return { ...EMPTY_WINDOW };
    return {
      eventLoopLagP50Ms: milliseconds(this.histogram.percentile(50)),
      eventLoopLagP99Ms: milliseconds(this.histogram.percentile(99)),
      eventLoopLagMaxMs: milliseconds(this.histogram.max),
      eventLoopLagSamples: count,
    };
  }
}
