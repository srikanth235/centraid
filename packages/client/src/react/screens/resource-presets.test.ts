import { describe, expect, it } from 'vitest';
import {
  formatInterval,
  PRESET_MODES,
  presetHint,
  RESOURCE_PRESETS,
  resourceCompareRows,
} from './resource-presets.js';

describe('RESOURCE_PRESETS mirror', () => {
  it('carries the gateway budget-preset values', () => {
    expect(RESOURCE_PRESETS.conserve.workerMaxConcurrent).toBe(2);
    expect(RESOURCE_PRESETS.balanced.workerMaxConcurrent).toBe(8);
    expect(RESOURCE_PRESETS.performance.workerMaxConcurrent).toBe(12);
    expect(RESOURCE_PRESETS.conserve.sqliteSynchronous).toBe('NORMAL');
    expect(RESOURCE_PRESETS.balanced.sqliteSynchronous).toBe('FULL');
    expect(RESOURCE_PRESETS.balanced.cpuShare).toBe(0.75);
    expect(RESOURCE_PRESETS.performance.cpuShare).toBe(1);
  });

  it('orders the presets constrained → generous', () => {
    expect(PRESET_MODES).toEqual(['conserve', 'balanced', 'performance']);
  });
});

describe('formatInterval', () => {
  it('prefers whole hours and minutes over large minute counts', () => {
    expect(formatInterval(2 * 60 * 60 * 1000)).toBe('2 h');
    expect(formatInterval(60 * 60 * 1000)).toBe('1 h');
    expect(formatInterval(2 * 60 * 1000)).toBe('2 min');
    expect(formatInterval(60 * 1000)).toBe('1 min');
    expect(formatInterval(800)).toBe('1s');
  });

  it('guards non-finite / negative input', () => {
    expect(formatInterval(-1)).toBe('—');
    expect(formatInterval(Number.NaN)).toBe('—');
  });
});

describe('presetHint', () => {
  it('reads "detect" for auto and "workers · memory" for presets', () => {
    expect(presetHint('auto')).toBe('detect');
    expect(presetHint('conserve').startsWith('2 · ')).toBe(true);
    expect(presetHint('balanced')).toBe('8 · 2.0 GB');
    expect(presetHint('performance')).toBe('12 · 4.5 GB');
  });
});

describe('resourceCompareRows', () => {
  it('produces one formatted value per preset for each knob', () => {
    const rows = resourceCompareRows();
    const byKey = (k: string): Record<string, string> | undefined =>
      rows.find((r) => r.key === k)?.values;

    expect(byKey('cpu')).toEqual({ conserve: '50%', balanced: '75%', performance: '100%' });
    expect(byKey('workers')).toEqual({ conserve: '2', balanced: '8', performance: '12' });
    expect(byKey('memory')?.balanced).toBe('2.0 GB');
    expect(byKey('memory')?.performance).toBe('4.5 GB');
    expect(byKey('pool')).toEqual({ conserve: 'none', balanced: '2', performance: '4' });
    expect(byKey('sweep')).toEqual({ conserve: '2 h', balanced: '1 h', performance: '1 h' });
    expect(byKey('durability')).toEqual({
      conserve: 'Relaxed',
      balanced: 'Full',
      performance: 'Full',
    });
  });

  it('every row exposes a plain-English hint for the tooltip', () => {
    for (const row of resourceCompareRows()) {
      expect(row.hint.length).toBeGreaterThan(10);
    }
  });
});
