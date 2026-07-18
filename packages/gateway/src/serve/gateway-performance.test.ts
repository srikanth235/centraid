import { afterEach, describe, expect, it, vi } from 'vitest';
import { GatewayPerformanceMonitor } from './gateway-performance.js';

class FakeHistogram {
  count = 4;
  max = 80_000_000;
  enabled = false;
  resetCount = 0;
  p99 = 65_000_000;

  enable(): boolean {
    this.enabled = true;
    return true;
  }

  disable(): boolean {
    this.enabled = false;
    return true;
  }

  reset(): void {
    this.resetCount += 1;
  }

  percentile(percentile: number): number {
    return percentile === 50 ? 15_000_000 : this.p99;
  }
}

describe('GatewayPerformanceMonitor', () => {
  afterEach(() => vi.useRealTimers());

  it('surfaces event-loop delay in milliseconds and the boot fsync sample', () => {
    const histogram = new FakeHistogram();
    const monitor = new GatewayPerformanceMonitor({
      histogram,
      resolutionMs: 10,
      sampleWindowMs: 0,
      storageFsyncMs: 12.5,
    });

    expect(monitor.snapshot()).toEqual({
      eventLoopLagP50Ms: 5,
      eventLoopLagP99Ms: 55,
      eventLoopLagMaxMs: 70,
      eventLoopLagPeakP99Ms: 55,
      eventLoopLagSamples: 4,
      storageFsyncMs: 12.5,
    });
    expect(monitor.shouldDeferBackgroundWork(50)).toBe(true);
    histogram.p99 = 20_000_000;
    monitor.resetMeasurement();
    expect(monitor.snapshot().eventLoopLagPeakP99Ms).toBe(10);
    expect(histogram.resetCount).toBe(1);
    monitor.close();
    expect(histogram.enabled).toBe(false);
  });

  it('subtracts the sampling interval so an idle histogram reports zero lag', () => {
    const histogram = new FakeHistogram();
    histogram.max = 20_000_000;
    histogram.p99 = 20_000_000;
    const monitor = new GatewayPerformanceMonitor({ histogram, sampleWindowMs: 0 });

    expect(monitor.snapshot()).toMatchObject({
      eventLoopLagP50Ms: 0,
      eventLoopLagP99Ms: 0,
      eventLoopLagMaxMs: 0,
    });
    expect(monitor.shouldDeferBackgroundWork()).toBe(false);
    monitor.close();
  });

  it('does not shed while the histogram has no samples', () => {
    const histogram = new FakeHistogram();
    histogram.count = 0;
    const monitor = new GatewayPerformanceMonitor({ histogram, sampleWindowMs: 0 });
    expect(monitor.shouldDeferBackgroundWork()).toBe(false);
    expect(monitor.snapshot().eventLoopLagP99Ms).toBe(0);
    monitor.close();
  });

  it('keeps collection enabled continuously between rolling snapshots', async () => {
    vi.useFakeTimers();
    const histogram = new FakeHistogram();
    const monitor = new GatewayPerformanceMonitor({
      histogram,
      sampleWindowMs: 10,
      sampleIntervalMs: 20,
    });

    expect(histogram.enabled).toBe(true);
    await vi.advanceTimersByTimeAsync(10);
    expect(histogram.enabled).toBe(true);
    expect(histogram.resetCount).toBe(1);
    await vi.advanceTimersByTimeAsync(20);
    expect(histogram.enabled).toBe(true);
    expect(histogram.resetCount).toBe(2);
    monitor.close();
  });
});
