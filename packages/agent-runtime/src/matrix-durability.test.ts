/**
 * Matrix cell agent-runtime.durability (#535 coverable-today).
 * Preflight cache must be clearable and semver parse must be stable.
 */
import { expect, test } from 'vitest';
import {
  compareSemver,
  invalidatePreflightCache,
  minVersionString,
  parseSemver,
} from './preflight.ts';
import { getRunnerBackend } from './registry.ts';

test('invalidatePreflightCache is safe to call repeatedly (no throw)', () => {
  invalidatePreflightCache();
  invalidatePreflightCache();
  expect(true).toBe(true);
});

test('parseSemver round-trips minVersionString for registered kinds', () => {
  const kind = 'gemini' as const;
  const backend = getRunnerBackend(kind);
  const text = minVersionString(kind);
  const parsed = parseSemver(text);
  expect(parsed).toEqual(backend.minVersion);
  expect(compareSemver(parsed!, backend.minVersion)).toBe(0);
});

test('parseSemver rejects garbage so callers cannot treat bad versions as ok', () => {
  expect(parseSemver('not-a-version')).toBeUndefined();
  expect(parseSemver('')).toBeUndefined();
});
