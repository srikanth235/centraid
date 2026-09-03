import { monitorEventLoopDelay } from "node:perf_hooks";

import { unrefTimer } from "../lib/unref-timer.js";

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
  enable: () => boolean;
  disable: () => boolean;
  reset: () => void;
  percentile: (percentile: number) => number;
}

export interface GatewayPerformanceMonitorOptions {
  resolutionMs?: number;
  sampleWindowMs?: number;
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

export class GatewayPerformanceMonitor {
  private readonly histogram: EventLoopDelayHistogramLike;
  private readonly resolutionMs: number;
  private timer?: ReturnType<typeof setTimeout>;
  private readonly sampleIntervalMs: number;
  private lastWindow = { ...EMPTY_WINDOW };
  private peakP99Ms = 0;
  private storageFsyncMs?: number;
  private closed = false;

  constructor(options: GatewayPerformanceMonitorOptions = {}) {
    this.resolutionMs = options.resolutionMs ?? 20;
    this.histogram =
      options.histogram ??
      monitorEventLoopDelay({ resolution: this.resolutionMs });
    this.storageFsyncMs = options.storageFsyncMs;
    const firstWindowMs = options.sampleWindowMs ?? 1_000;
    this.sampleIntervalMs = Math.max(
      1,
      options.sampleIntervalMs ?? firstWindowMs
    );
    this.histogram.enable();
    if (firstWindowMs > 0) this.scheduleWindowEnd(firstWindowMs);
  }

  setStorageFsyncMs(value: number): void {
    this.storageFsyncMs = value;
  }

  snapshot(): GatewayPerformanceSnapshot {
    const current = this.readWindow();
    const signal = current.eventLoopLagSamples > 0 ? current : this.lastWindow;
    if (!this.timer) {
      this.peakP99Ms = Math.max(this.peakP99Ms, signal.eventLoopLagP99Ms);
    }
    return {
      ...signal,
      eventLoopLagPeakP99Ms: this.peakP99Ms,
      ...(this.storageFsyncMs === undefined
        ? {}
        : { storageFsyncMs: this.storageFsyncMs }),
    };
  }

  shouldDeferBackgroundWork(maxP99Ms = 50): boolean {
    return this.snapshot().eventLoopLagP99Ms >= maxP99Ms;
  }

  resetMeasurement(): void {
    this.lastWindow = { ...EMPTY_WINDOW };
    this.peakP99Ms = 0;
    this.histogram.reset();
    if (this.timer) {
      clearTimeout(this.timer);
      this.scheduleWindowEnd(this.sampleIntervalMs);
    }
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
    unrefTimer(this.timer);
  }

  private readWindow(): typeof EMPTY_WINDOW {
    const count = Number(this.histogram.count);
    if (!Number.isFinite(count) || count <= 0) return { ...EMPTY_WINDOW };
    const lagMilliseconds = (nanoseconds: number): number =>
      Math.max(0, milliseconds(nanoseconds) - this.resolutionMs);
    return {
      eventLoopLagP50Ms: lagMilliseconds(this.histogram.percentile(50)),
      eventLoopLagP99Ms: lagMilliseconds(this.histogram.percentile(99)),
      eventLoopLagMaxMs: lagMilliseconds(this.histogram.max),
      eventLoopLagSamples: count,
    };
  }
}
