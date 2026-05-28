import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { appIdFromSessionKey, SESSION_PREFIX } from './tools.js';

describe('appIdFromSessionKey', () => {
  it('returns undefined for undefined input', () => {
    assert.equal(appIdFromSessionKey(undefined), undefined);
  });

  it('returns undefined when the marker is missing', () => {
    assert.equal(appIdFromSessionKey(''), undefined);
    assert.equal(appIdFromSessionKey('agent:main:other-flow:todos'), undefined);
  });

  it('extracts the app id from a bare client-side key', () => {
    assert.equal(appIdFromSessionKey(`${SESSION_PREFIX}todos:w1`), 'todos');
  });

  it('extracts the app id from a gateway-prefixed key', () => {
    // OpenClaw wraps client session keys as `agent:<agentId>:<key>`.
    assert.equal(appIdFromSessionKey(`agent:main:${SESSION_PREFIX}todos:w1`), 'todos');
  });

  it('handles a key with no trailing segment', () => {
    assert.equal(appIdFromSessionKey(`${SESSION_PREFIX}journal`), 'journal');
  });

  it('handles ids that contain hyphens', () => {
    assert.equal(appIdFromSessionKey(`agent:main:${SESSION_PREFIX}hydrate-2:w1`), 'hydrate-2');
  });
});
