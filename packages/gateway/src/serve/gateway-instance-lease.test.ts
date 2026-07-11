import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, promises as fs, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import type { RuntimeLogger } from '@centraid/app-engine';
import { HealthRegistry } from './health-registry.js';
import {
  GatewayInstanceLease,
  LEASE_FILE_NAME,
  LEASE_FRESH_WINDOW_MS,
  type LeaseRecord,
} from './gateway-instance-lease.js';

const silentLogger: RuntimeLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `gateway-lease-${crypto.randomUUID()}-`));
  cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

function writeForeignLease(dir: string, patch: Partial<LeaseRecord> = {}): LeaseRecord {
  const record: LeaseRecord = {
    instanceId: crypto.randomUUID(),
    pid: 99999,
    hostname: 'rival-host',
    startedAt: new Date(0).toISOString(),
    renewedAt: new Date(0).toISOString(),
    ...patch,
  };
  writeFileSync(path.join(dir, LEASE_FILE_NAME), JSON.stringify(record));
  return record;
}

describe('GatewayInstanceLease', () => {
  it('claims an absent lease and writes it under LEASE_FILE_NAME', async () => {
    const dir = await tempDir();
    const health = new HealthRegistry();
    const lease = new GatewayInstanceLease({ rootDir: dir, health, logger: silentLogger });

    lease.start();
    cleanups.push(() => lease.stop());

    const leaseFile = path.join(dir, LEASE_FILE_NAME);
    expect(existsSync(leaseFile)).toBe(true);
    const record = JSON.parse(readFileSync(leaseFile, 'utf8')) as LeaseRecord;
    expect(record.instanceId).toBe(lease.instanceId);

    const snap = await health.snapshot();
    const instance = snap.components.find((c) => c.component === 'instance');
    expect(instance?.status).toBe('ok');
    expect(lease.isConflicted()).toBe(false);
  });

  it('detects a fresh foreign lease at start and never clobbers it', async () => {
    const dir = await tempDir();
    let clock = 1_000_000;
    const rival = writeForeignLease(dir, { renewedAt: new Date(clock).toISOString() });
    const health = new HealthRegistry({ now: () => clock });
    const lease = new GatewayInstanceLease({
      rootDir: dir,
      health,
      logger: silentLogger,
      now: () => clock,
    });

    lease.start();
    cleanups.push(() => lease.stop());

    expect(lease.isConflicted()).toBe(true);
    const snap = await health.snapshot();
    const instance = snap.components.find((c) => c.component === 'instance');
    expect(instance?.status).toBe('error');
    expect(instance?.lastError).toContain(String(rival.pid));
    expect(instance?.lastError).toContain(rival.hostname);

    // The rival's file must be untouched — no clobber-write.
    const onDisk = JSON.parse(readFileSync(path.join(dir, LEASE_FILE_NAME), 'utf8')) as LeaseRecord;
    expect(onDisk.instanceId).toBe(rival.instanceId);
  });

  it('takes over a stale lease cleanly (crashed owner past LEASE_FRESH_WINDOW_MS)', async () => {
    const dir = await tempDir();
    let clock = 1_000_000;
    const rival = writeForeignLease(dir, {
      renewedAt: new Date(clock - LEASE_FRESH_WINDOW_MS - 1).toISOString(),
    });
    const health = new HealthRegistry({ now: () => clock });
    const lease = new GatewayInstanceLease({
      rootDir: dir,
      health,
      logger: silentLogger,
      now: () => clock,
    });

    lease.start();
    cleanups.push(() => lease.stop());

    expect(lease.isConflicted()).toBe(false);
    const onDisk = JSON.parse(readFileSync(path.join(dir, LEASE_FILE_NAME), 'utf8')) as LeaseRecord;
    expect(onDisk.instanceId).toBe(lease.instanceId);
    expect(onDisk.instanceId).not.toBe(rival.instanceId);

    const snap = await health.snapshot();
    const instance = snap.components.find((c) => c.component === 'instance');
    expect(instance?.status).toBe('ok');
    expect(instance?.detail).toContain('reclaimed');
  });

  it('renew detects a foreign rewrite mid-run, flips to error, and stops clobbering until it clears', async () => {
    const dir = await tempDir();
    let clock = 1_000_000;
    const health = new HealthRegistry({ now: () => clock });
    const lease = new GatewayInstanceLease({
      rootDir: dir,
      health,
      logger: silentLogger,
      now: () => clock,
    });

    // Access the private renew for deterministic, non-timer-driven ticks.
    const renew = (lease as unknown as { checkAndRenew: () => void }).checkAndRenew.bind(lease);

    renew(); // initial claim
    expect(lease.isConflicted()).toBe(false);

    // A rival force-writes over our lease (bypassing the fresh-lease guard
    // itself — simulating an older/buggy peer, or a genuine race).
    clock += 5_000;
    const rival = writeForeignLease(dir, { renewedAt: new Date(clock).toISOString() });

    renew(); // our tick notices the foreign rewrite
    expect(lease.isConflicted()).toBe(true);
    let snap = await health.snapshot();
    expect(snap.components.find((c) => c.component === 'instance')?.status).toBe('error');

    // Another tick while the rival's lease is still fresh must NOT clobber it.
    clock += 1_000;
    renew();
    let onDisk = JSON.parse(readFileSync(path.join(dir, LEASE_FILE_NAME), 'utf8')) as LeaseRecord;
    expect(onDisk.instanceId).toBe(rival.instanceId);
    expect(lease.isConflicted()).toBe(true);

    // Once the rival's lease ages past freshness (they stopped renewing —
    // crashed or exited), the next tick reclaims cleanly.
    clock += LEASE_FRESH_WINDOW_MS + 1;
    renew();
    expect(lease.isConflicted()).toBe(false);
    onDisk = JSON.parse(readFileSync(path.join(dir, LEASE_FILE_NAME), 'utf8')) as LeaseRecord;
    expect(onDisk.instanceId).toBe(lease.instanceId);
    snap = await health.snapshot();
    expect(snap.components.find((c) => c.component === 'instance')?.status).toBe('ok');
  });

  it('graceful stop removes the lease file when we still own it', async () => {
    const dir = await tempDir();
    const health = new HealthRegistry();
    const lease = new GatewayInstanceLease({ rootDir: dir, health, logger: silentLogger });

    lease.start();
    expect(existsSync(path.join(dir, LEASE_FILE_NAME))).toBe(true);

    lease.stop();
    expect(existsSync(path.join(dir, LEASE_FILE_NAME))).toBe(false);
  });

  it('stop() does NOT remove a foreign lease when we never won the conflict', async () => {
    const dir = await tempDir();
    let clock = 1_000_000;
    const rival = writeForeignLease(dir, { renewedAt: new Date(clock).toISOString() });
    const health = new HealthRegistry({ now: () => clock });
    const lease = new GatewayInstanceLease({
      rootDir: dir,
      health,
      logger: silentLogger,
      now: () => clock,
    });

    lease.start();
    expect(lease.isConflicted()).toBe(true);

    lease.stop();
    const onDisk = JSON.parse(readFileSync(path.join(dir, LEASE_FILE_NAME), 'utf8')) as LeaseRecord;
    expect(onDisk.instanceId).toBe(rival.instanceId);
  });

  it('treats a corrupt lease file as absent and self-heals by reclaiming it', async () => {
    const dir = await tempDir();
    writeFileSync(path.join(dir, LEASE_FILE_NAME), 'not json{{{');
    const health = new HealthRegistry();
    const lease = new GatewayInstanceLease({ rootDir: dir, health, logger: silentLogger });

    lease.start();
    cleanups.push(() => lease.stop());

    const onDisk = JSON.parse(readFileSync(path.join(dir, LEASE_FILE_NAME), 'utf8')) as LeaseRecord;
    expect(onDisk.instanceId).toBe(lease.instanceId);
    const snap = await health.snapshot();
    expect(snap.components.find((c) => c.component === 'instance')?.status).toBe('ok');
  });
});
