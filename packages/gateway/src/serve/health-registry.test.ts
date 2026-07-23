import { describe, expect, it } from 'vitest';
import type { RuntimeLogger } from '@centraid/app-engine';
import { HealthRegistry } from './health-registry.js';

const silentLogger: RuntimeLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

describe('HealthRegistry', () => {
  it('starts with no components and overall ok', async () => {
    const registry = new HealthRegistry();
    const snap = await registry.snapshot();
    expect(snap.status).toBe('ok');
    expect(snap.components).toEqual([]);
    expect(snap.recentEvents).toEqual([]);
  });

  it('tracks ok → error → ok transitions with timestamps', async () => {
    let clock = 1_000;
    const registry = new HealthRegistry({ now: () => clock });

    clock = 2_000;
    registry.reportOk('outbox', 'drained');
    clock = 3_000;
    registry.reportError('outbox', 'drain failed: boom');

    let snap = await registry.snapshot();
    let outbox = snap.components.find((c) => c.component === 'outbox');
    expect(outbox?.status).toBe('error');
    expect(outbox?.lastError).toBe('drain failed: boom');
    expect(outbox?.lastOkAt).toBe(new Date(2_000).toISOString());
    expect(outbox?.lastErrorAt).toBe(new Date(3_000).toISOString());
    expect(outbox?.errorCount).toBe(1);
    expect(snap.status).toBe('error');

    clock = 4_000;
    registry.reportOk('outbox');
    snap = await registry.snapshot();
    outbox = snap.components.find((c) => c.component === 'outbox');
    // Recovers to ok but keeps the error history for diagnosis.
    expect(outbox?.status).toBe('ok');
    expect(outbox?.lastError).toBe('drain failed: boom');
    expect(outbox?.errorCount).toBe(1);
    expect(snap.status).toBe('ok');
  });

  it('overall status is the worst component', async () => {
    const registry = new HealthRegistry();
    registry.reportOk('a');
    registry.reportDegraded('b', 'slow');
    expect((await registry.snapshot()).status).toBe('degraded');
    registry.reportError('c', 'down');
    expect((await registry.snapshot()).status).toBe('error');
  });

  it('loggerFor records warns as events without flipping status', async () => {
    const registry = new HealthRegistry({ now: () => 5_000 });
    const seen: string[] = [];
    const logger = registry.loggerFor('automations', {
      ...silentLogger,
      warn: (m) => seen.push(m),
    });

    logger.warn('scheduled ref failed: transient');
    const snap = await registry.snapshot();
    const comp = snap.components.find((c) => c.component === 'automations');
    expect(comp?.status).toBe('ok');
    expect(seen).toEqual(['scheduled ref failed: transient']);
    expect(snap.recentEvents).toEqual([
      {
        at: new Date(5_000).toISOString(),
        component: 'automations',
        level: 'warn',
        message: 'scheduled ref failed: transient',
      },
    ]);
  });

  it('loggerFor flips status on error and passes through to the base logger', async () => {
    const registry = new HealthRegistry();
    const seen: string[] = [];
    const logger = registry.loggerFor('vaults', { ...silentLogger, error: (m) => seen.push(m) });

    logger.error('sqlite is corrupt');
    const snap = await registry.snapshot();
    const comp = snap.components.find((c) => c.component === 'vaults');
    expect(comp?.status).toBe('error');
    expect(comp?.lastError).toBe('sqlite is corrupt');
    expect(seen).toEqual(['sqlite is corrupt']);
  });

  it('caps the event ring buffer, newest first in snapshots', async () => {
    const registry = new HealthRegistry({ maxEvents: 3, now: () => 0 });
    const logger = registry.loggerFor('x', silentLogger);
    for (let i = 1; i <= 5; i++) logger.warn(`w${i}`);

    const snap = await registry.snapshot();
    expect(snap.recentEvents.map((e) => e.message)).toEqual(['w5', 'w4', 'w3']);
  });

  it('probe result wins the component status at snapshot time', async () => {
    const registry = new HealthRegistry();
    registry.reportError('vaults', 'mount failed');
    registry.registerProbe('vaults', async () => ({ status: 'ok', detail: '2 vaults mounted' }));

    const snap = await registry.snapshot();
    const comp = snap.components.find((c) => c.component === 'vaults');
    expect(comp?.status).toBe('ok');
    expect(comp?.detail).toBe('2 vaults mounted');
    // Error history survives the recovery.
    expect(comp?.lastError).toBe('mount failed');
  });

  it('a throwing probe marks the component error', async () => {
    const registry = new HealthRegistry();
    registry.registerProbe('vaults', async () => {
      throw new Error('registry unreachable');
    });

    const snap = await registry.snapshot();
    const comp = snap.components.find((c) => c.component === 'vaults');
    expect(comp?.status).toBe('error');
    expect(comp?.lastError).toBe('registry unreachable');
    expect(snap.status).toBe('error');
  });

  it('reports uptime from construction', async () => {
    let clock = 10_000;
    const registry = new HealthRegistry({ now: () => clock });
    clock = 25_000;
    const snap = await registry.snapshot();
    expect(snap.startedAt).toBe(new Date(10_000).toISOString());
    expect(snap.uptimeMs).toBe(15_000);
  });

  describe('metrics (issue #351 tier 3)', () => {
    it('always includes rssBytes + uptimeMs, with outboxPending defaulting to 0, unwired', async () => {
      const registry = new HealthRegistry();
      const snap = await registry.snapshot();
      expect(snap.metrics.rssBytes).toBeGreaterThan(0);
      expect(snap.metrics.outboxPending).toBe(0);
      expect(snap.metrics.uptimeMs).toBe(snap.uptimeMs);
      expect(snap.metrics.sseClients).toBeUndefined();
    });

    it('pulls outboxPending/sseClients from the injected source at snapshot time', async () => {
      const registry = new HealthRegistry();
      let pending = 3;
      registry.setMetricsSource(() => ({ outboxPending: pending, sseClients: 2 }));

      let snap = await registry.snapshot();
      expect(snap.metrics.outboxPending).toBe(3);
      expect(snap.metrics.sseClients).toBe(2);

      // Re-read on every call — not cached from registration time.
      pending = 7;
      snap = await registry.snapshot();
      expect(snap.metrics.outboxPending).toBe(7);
    });

    it('omits sseClients when the source leaves it unset', async () => {
      const registry = new HealthRegistry();
      registry.setMetricsSource(() => ({ outboxPending: 1 }));
      const snap = await registry.snapshot();
      expect(snap.metrics.outboxPending).toBe(1);
      expect('sseClients' in snap.metrics).toBe(false);
    });

    it('surfaces performance metrics and exposes the shared load-shed signal', async () => {
      const registry = new HealthRegistry();
      let p99 = 18;
      let resets = 0;
      registry.setPerformanceMetricsSource(
        () => ({
          eventLoopLagP50Ms: 7,
          eventLoopLagP99Ms: p99,
          eventLoopLagMaxMs: 25,
          eventLoopLagPeakP99Ms: 44,
          eventLoopLagSamples: 100,
          storageFsyncMs: 11,
        }),
        () => {
          resets += 1;
        },
      );
      registry.setMetricsSource(() => ({
        outboxPending: 0,
        hardwareProfileClass: 'constrained',
        resourceMode: 'conserve',
      }));

      const snap = await registry.snapshot();
      expect(snap.metrics).toMatchObject({
        eventLoopLagP50Ms: 7,
        eventLoopLagP99Ms: 18,
        storageFsyncMs: 11,
        hardwareProfileClass: 'constrained',
        resourceMode: 'conserve',
      });
      expect(typeof snap.metrics.rssBytes).toBe('number');
      expect(snap.metrics.rssBytes).toBeGreaterThan(0);
      expect(registry.shouldDeferBackgroundWork()).toBe(false);
      p99 = 51;
      expect(registry.shouldDeferBackgroundWork()).toBe(true);
      expect((await registry.snapshot()).components).toContainEqual(
        expect.objectContaining({
          component: 'load-shed',
          status: 'degraded',
          detail: expect.stringContaining('pausing backups'),
        }),
      );
      registry.resetPerformanceMetrics();
      expect(resets).toBe(1);
    });

    it('carries an injected structured resourceProfile through the snapshot', async () => {
      const registry = new HealthRegistry();
      const resourceProfile = {
        class: 'standard' as const,
        mode: 'balanced' as const,
        host: { cores: 8, totalMemoryBytes: 16 * 1024 ** 3, storageFsyncMs: 2 },
        resolved: {
          workerMaxConcurrent: 8,
          workerMaxOldGenerationMb: 256,
          workerPoolSize: 2,
          replicationConcurrency: 3,
          staticBrotliQuality: 10,
          staticGzipQuality: 9,
          sqliteSynchronous: 'FULL' as const,
          vaultSweepIntervalMs: 3_600_000,
          outboxIdleIntervalMs: 60_000,
        },
      };
      registry.setMetricsSource(() => ({ outboxPending: 0, resourceProfile }));
      const snap = await registry.snapshot();
      expect(snap.metrics.resourceProfile).toEqual(resourceProfile);
    });

    it('forces one visible background pass after sustained load shedding', async () => {
      let clock = 1_000;
      let p99 = 75;
      const registry = new HealthRegistry({ now: () => clock, maxLoadShedMs: 5_000 });
      registry.setPerformanceMetricsSource(() => ({ eventLoopLagP99Ms: p99 }));

      expect(registry.shouldDeferBackgroundWork()).toBe(true);
      clock += 4_999;
      expect(registry.shouldDeferBackgroundWork()).toBe(true);
      clock += 1;
      expect(registry.shouldDeferBackgroundWork()).toBe(false);
      expect(registry.shouldDeferBackgroundWork()).toBe(true);
      expect((await registry.snapshot()).components).toContainEqual(
        expect.objectContaining({
          component: 'load-shed',
          status: 'degraded',
          detail: expect.stringMatching(/deferred background pass|pausing backups/),
        }),
      );

      p99 = 10;
      expect(registry.shouldDeferBackgroundWork()).toBe(false);
      expect((await registry.snapshot()).components).toContainEqual(
        expect.objectContaining({
          component: 'load-shed',
          status: 'ok',
          detail: expect.stringContaining('pressure cleared'),
        }),
      );
    });
  });

  describe('background pause (issue #528 Phase B)', () => {
    it('is unpaused by default and exposes an unpaused snapshot window', async () => {
      const registry = new HealthRegistry();
      expect(registry.shouldPauseBackgroundWork()).toBe(false);
      expect(registry.backgroundPauseState()).toEqual({ paused: false, until: null });
      expect((await registry.snapshot()).metrics.backgroundPause).toEqual({
        paused: false,
        until: null,
      });
    });

    it('pauses indefinitely with a null until and records an event', async () => {
      const registry = new HealthRegistry({ now: () => 1_000 });
      const state = registry.pauseBackgroundWork();
      expect(state).toEqual({ paused: true, until: null });
      expect(registry.shouldPauseBackgroundWork()).toBe(true);

      const snap = await registry.snapshot();
      expect(snap.metrics.backgroundPause).toEqual({ paused: true, until: null });
      expect(snap.components).toContainEqual(
        expect.objectContaining({ component: 'background-pause', status: 'degraded' }),
      );
      expect(snap.recentEvents).toContainEqual(
        expect.objectContaining({ component: 'background-pause', level: 'warn' }),
      );
    });

    it('auto-lifts a duration-bounded pause once the clock passes until', () => {
      let clock = 1_000;
      const registry = new HealthRegistry({ now: () => clock });
      const state = registry.pauseBackgroundWork(5_000);
      expect(state.until).toBe(new Date(6_000).toISOString());

      clock = 5_999;
      expect(registry.shouldPauseBackgroundWork()).toBe(true);
      clock = 6_000;
      expect(registry.shouldPauseBackgroundWork()).toBe(false);
      expect(registry.backgroundPauseState()).toEqual({ paused: false, until: null });
    });

    it('resume lifts an active pause and is a no-op afterward', async () => {
      const registry = new HealthRegistry();
      registry.pauseBackgroundWork();
      expect(registry.resumeBackgroundWork()).toEqual({ paused: false, until: null });
      expect(registry.shouldPauseBackgroundWork()).toBe(false);

      const before = (await registry.snapshot()).recentEvents.length;
      registry.resumeBackgroundWork();
      const after = (await registry.snapshot()).recentEvents.length;
      // Idempotent: a second resume emits no further event.
      expect(after).toBe(before);
      expect((await registry.snapshot()).components).toContainEqual(
        expect.objectContaining({ component: 'background-pause', status: 'ok' }),
      );
    });
  });
});
