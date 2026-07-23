import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  formatBudgetSummary,
  formatFriendlyMs,
  formatGb,
  formatMbAsGb,
  formatPauseUntil,
  hostFactRows,
  msUntilTonight,
  resolvedKnobRows,
  type ResourceProfileDTO,
} from './resource-summary.js';

const sample: ResourceProfileDTO = {
  class: 'standard',
  mode: 'balanced',
  host: { cores: 8, totalMemoryBytes: 16 * 1024 ** 3, storageFsyncMs: 1.5 },
  resolved: {
    workerMaxConcurrent: 2,
    workerMaxOldGenerationMb: 1280,
    workerPoolSize: 3,
    replicationConcurrency: 2,
    staticBrotliQuality: 6,
    staticGzipQuality: 7,
    sqliteSynchronous: 'FULL',
    vaultSweepIntervalMs: 300_000,
    outboxIdleIntervalMs: 1000,
  },
};

afterEach(() => {
  vi.useRealTimers();
});

describe('byte + duration formatting', () => {
  it('formats GB with one decimal', () => {
    expect(formatGb(16 * 1024 ** 3)).toBe('16.0 GB');
    expect(formatGb(2.5 * 1024 ** 3)).toBe('2.5 GB');
    expect(formatGb(-1)).toBe('—');
  });

  it('formats MB as GB with one decimal', () => {
    expect(formatMbAsGb(2560)).toBe('2.5 GB');
    expect(formatMbAsGb(1024)).toBe('1.0 GB');
  });

  it('formats friendly durations', () => {
    expect(formatFriendlyMs(800)).toBe('800 ms');
    expect(formatFriendlyMs(30_000)).toBe('30s');
    expect(formatFriendlyMs(1500)).toBe('1.5s');
    expect(formatFriendlyMs(300_000)).toBe('5 min');
    expect(formatFriendlyMs(90_000)).toBe('1.5 min');
  });
});

describe('formatBudgetSummary', () => {
  it('leads with memory in GB and worker/core counts', () => {
    expect(formatBudgetSummary(sample)).toBe(
      'Up to ~2.5 GB memory · 2 background workers on 8 cores',
    );
  });

  it('singularizes a lone worker/core', () => {
    const solo: ResourceProfileDTO = {
      ...sample,
      host: { ...sample.host, cores: 1 },
      resolved: { ...sample.resolved, workerMaxConcurrent: 1 },
    };
    expect(formatBudgetSummary(solo)).toBe('Up to ~1.3 GB memory · 1 background worker on 1 core');
  });
});

describe('msUntilTonight', () => {
  it('counts to 20:00 the same day when before', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 6, 23, 10, 0, 0));
    expect(msUntilTonight(Date.now())).toBe(10 * 3_600_000);
  });

  it('counts to 20:00 tomorrow when already past', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 6, 23, 21, 0, 0));
    expect(msUntilTonight(Date.now())).toBe(23 * 3_600_000);
  });
});

describe('formatPauseUntil', () => {
  it('renders a local clock time when set', () => {
    const at = new Date(2026, 6, 23, 14, 5, 0).toISOString();
    expect(formatPauseUntil(at)).toBe('Paused until 14:05');
  });

  it('falls back to the indefinite phrasing', () => {
    expect(formatPauseUntil(null)).toBe('Paused until you resume');
    expect(formatPauseUntil('not-a-date')).toBe('Paused until you resume');
  });
});

describe('L2 fact rows', () => {
  it('lists host facts, "not measured" when fsync is null', () => {
    expect(hostFactRows(sample)).toEqual([
      { label: 'CPU cores', value: '8' },
      { label: 'Total memory', value: '16.0 GB' },
      { label: 'Storage fsync', value: '1.5 ms' },
    ]);
    const noFsync: ResourceProfileDTO = {
      ...sample,
      host: { ...sample.host, storageFsyncMs: null },
    };
    expect(hostFactRows(noFsync)[2]).toEqual({ label: 'Storage fsync', value: 'not measured' });
  });

  it('lists resolved knobs in friendly units', () => {
    const rows = resolvedKnobRows(sample);
    expect(rows).toContainEqual({ label: 'Workers × heap', value: '2 × 1280 MB' });
    expect(rows).toContainEqual({ label: 'SQLite durability', value: 'FULL' });
    expect(rows).toContainEqual({ label: 'Vault sweep', value: 'every 5 min' });
    expect(rows).toContainEqual({ label: 'Outbox idle poll', value: 'every 1s' });
    expect(rows).toContainEqual({ label: 'Compression', value: 'brotli q6 · gzip q7' });
  });
});
