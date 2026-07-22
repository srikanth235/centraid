import { expect, test } from 'vitest';
import { resolveToken } from './auth.ts';

test('resolveToken prefers --token over the environment', () => {
  const token = resolveToken({
    token: 'explicit',
    env: { CENTRAID_TOKEN: 'from-env', CENTRAID_GATEWAY_TOKEN: 'from-gw' },
  });
  expect(token).toBe('explicit');
});

test('resolveToken uses CENTRAID_TOKEN when no --token', () => {
  const token = resolveToken({ env: { CENTRAID_TOKEN: 'env-token' } });
  expect(token).toBe('env-token');
});

test('resolveToken falls back to CENTRAID_GATEWAY_TOKEN (the daemon loopback secret)', () => {
  // Issue #505 phase 7: there is no on-disk token.bin to auto-read; an operator
  // reuses the loopback secret the daemon was started with.
  const token = resolveToken({ env: { CENTRAID_GATEWAY_TOKEN: 'gw-secret' } });
  expect(token).toBe('gw-secret');
});

test('resolveToken returns undefined when nothing is supplied', () => {
  expect(resolveToken({ env: {} })).toBeUndefined();
});
