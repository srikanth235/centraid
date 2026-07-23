import { expect, test } from 'vitest';
import {
  formatEventLoopDetail,
  formatLoadShedDeferringDetail,
  formatLoadShedForcedPassDetail,
  formatRss,
  parseResourceMode,
  resolveResourceMode,
  resourceModeLabel,
  RESOURCE_MODE_PREF_KEY,
} from './resource-mode.js';

test('parseResourceMode accepts only the four owner modes', () => {
  expect(parseResourceMode('auto')).toBe('auto');
  expect(parseResourceMode('conserve')).toBe('conserve');
  expect(parseResourceMode('balanced')).toBe('balanced');
  expect(parseResourceMode('performance')).toBe('performance');
  expect(parseResourceMode('turbo')).toBeUndefined();
  expect(parseResourceMode(null)).toBeUndefined();
});

test('resolveResourceMode prefers env, then prefs, then daemon options', () => {
  expect(
    resolveResourceMode({
      env: { CENTRAID_RESOURCE_MODE: 'performance' },
      prefsMode: 'conserve',
      optionsMode: 'balanced',
    }),
  ).toBe('performance');
  expect(
    resolveResourceMode({
      env: {},
      prefsMode: 'conserve',
      optionsMode: 'balanced',
    }),
  ).toBe('conserve');
  expect(resolveResourceMode({ env: {}, optionsMode: 'balanced' })).toBe('balanced');
  expect(resolveResourceMode({ env: {} })).toBe('auto');
});

test('resource mode pref key is stable for the shell', () => {
  expect(RESOURCE_MODE_PREF_KEY).toBe('gateway.resourceMode');
});

test('event-loop and load-shed copy is human-readable under pressure', () => {
  expect(
    formatEventLoopDetail({
      eventLoopLagP50Ms: 4,
      eventLoopLagP99Ms: 12,
      eventLoopLagMaxMs: 20,
    }),
  ).toMatch(/^Responsive/);
  expect(
    formatEventLoopDetail({
      eventLoopLagP50Ms: 20,
      eventLoopLagP99Ms: 67.2,
      eventLoopLagMaxMs: 90,
    }),
  ).toContain('pausing non-urgent background work');
  expect(formatLoadShedDeferringDetail(67.2)).toContain('pausing backups');
  expect(formatLoadShedForcedPassDetail(80, 5_000)).toContain('one deferred background pass');
});

test('formatRss and labels stay owner-friendly', () => {
  expect(formatRss(200 * 1024 * 1024)).toBe('200.0 MB');
  expect(resourceModeLabel('auto')).toBe('Auto');
  expect(resourceModeLabel('conserve')).toBe('Conserve');
});
