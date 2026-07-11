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
});
