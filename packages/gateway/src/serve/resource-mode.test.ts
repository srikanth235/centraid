import { expect, test } from 'vitest';
import {
  formatEventLoopDetail,
  formatLoadShedDeferringDetail,
  formatLoadShedForcedPassDetail,
  formatRss,
  parseResourceKnobPrefs,
  parseResourceMode,
  resolveResourceMode,
  resourceModeLabel,
  RESOURCE_KNOB_PREF_KEYS,
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

test('resource knob pref keys are stable and namespaced for the shell', () => {
  expect(RESOURCE_KNOB_PREF_KEYS).toEqual({
    workerMaxConcurrent: 'gateway.resource.workerMaxConcurrent',
    workerMaxOldGenerationMb: 'gateway.resource.workerMaxOldGenerationMb',
    workerPoolSize: 'gateway.resource.workerPoolSize',
    replicationConcurrency: 'gateway.resource.replicationConcurrency',
  });
});

test('parseResourceKnobPrefs reads only the four knob keys as positive integers', () => {
  expect(
    parseResourceKnobPrefs({
      'gateway.resource.workerMaxConcurrent': 6,
      'gateway.resource.replicationConcurrency': 3,
      'gateway.resourceMode': 'balanced',
      unrelated: 42,
    }),
  ).toEqual({ workerMaxConcurrent: 6, replicationConcurrency: 3 });
});

test('parseResourceKnobPrefs drops garbage so a stale prefs.json never widens a bound', () => {
  expect(
    parseResourceKnobPrefs({
      'gateway.resource.workerMaxConcurrent': '8', // string
      'gateway.resource.workerMaxOldGenerationMb': -4, // negative
      'gateway.resource.workerPoolSize': 2.5, // float
      'gateway.resource.replicationConcurrency': Number.NaN, // NaN
    }),
  ).toEqual({});
});

test('parseResourceKnobPrefs returns an empty object for empty prefs', () => {
  expect(parseResourceKnobPrefs({})).toEqual({});
});
