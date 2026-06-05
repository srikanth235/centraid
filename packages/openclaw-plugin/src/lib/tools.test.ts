import { describe, expect, it } from 'vitest';
import { appIdFromSessionKey, SESSION_PREFIX } from './tools.js';

describe('appIdFromSessionKey', () => {
  it('returns undefined for undefined input', () => {
    expect(appIdFromSessionKey(undefined)).toBe(undefined);
  });

  it('returns undefined when the marker is missing', () => {
    expect(appIdFromSessionKey('')).toBe(undefined);
    expect(appIdFromSessionKey('agent:main:other-flow:todos')).toBe(undefined);
  });

  it('extracts the app id from a bare client-side key', () => {
    expect(appIdFromSessionKey(`${SESSION_PREFIX}todos:w1`)).toBe('todos');
  });

  it('extracts the app id from a gateway-prefixed key', () => {
    // OpenClaw wraps client session keys as `agent:<agentId>:<key>`.
    expect(appIdFromSessionKey(`agent:main:${SESSION_PREFIX}todos:w1`)).toBe('todos');
  });

  it('handles a key with no trailing segment', () => {
    expect(appIdFromSessionKey(`${SESSION_PREFIX}journal`)).toBe('journal');
  });

  it('handles ids that contain hyphens', () => {
    expect(appIdFromSessionKey(`agent:main:${SESSION_PREFIX}hydrate-2:w1`)).toBe('hydrate-2');
  });
});
