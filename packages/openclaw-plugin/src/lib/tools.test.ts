import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { appIdFromSessionKey, isSelectOnly, SESSION_PREFIX } from './tools.js';

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

describe('isSelectOnly', () => {
  it('accepts a basic SELECT', () => {
    assert.equal(isSelectOnly('SELECT * FROM todos'), true);
  });

  it('accepts SELECT with leading whitespace + comments', () => {
    assert.equal(isSelectOnly('  -- a note\n  SELECT 1'), true);
    assert.equal(isSelectOnly('/* block */ SELECT 1'), true);
  });

  it('accepts EXPLAIN SELECT', () => {
    assert.equal(isSelectOnly('EXPLAIN SELECT * FROM todos'), true);
  });

  it('rejects empty / whitespace-only SQL', () => {
    assert.equal(isSelectOnly(''), false);
    assert.equal(isSelectOnly('   '), false);
    assert.equal(isSelectOnly('-- only a comment'), false);
  });

  it('rejects writes and DDL', () => {
    assert.equal(isSelectOnly('INSERT INTO todos VALUES (1)'), false);
    assert.equal(isSelectOnly('UPDATE todos SET done = 1'), false);
    assert.equal(isSelectOnly('DELETE FROM todos'), false);
    assert.equal(isSelectOnly('DROP TABLE todos'), false);
    assert.equal(isSelectOnly('CREATE TABLE x (a INT)'), false);
    assert.equal(isSelectOnly('ALTER TABLE todos ADD COLUMN x INT'), false);
    assert.equal(isSelectOnly('REPLACE INTO todos VALUES (1)'), false);
  });

  it('rejects PRAGMA + ATTACH + VACUUM + REINDEX', () => {
    assert.equal(isSelectOnly('PRAGMA table_info(todos)'), false);
    assert.equal(isSelectOnly('ATTACH DATABASE "x.db" AS x'), false);
    assert.equal(isSelectOnly('VACUUM'), false);
    assert.equal(isSelectOnly('REINDEX todos'), false);
  });

  it('rejects EXPLAIN INSERT (write intent dressed up as EXPLAIN)', () => {
    // The guard's keyword-anywhere check refuses any write verb in the
    // statement body, even when the first token is EXPLAIN.
    assert.equal(isSelectOnly('EXPLAIN INSERT INTO todos VALUES (1)'), false);
  });

  it('rejects piggybacked writes inside a CTE', () => {
    assert.equal(isSelectOnly('WITH x AS (SELECT 1) INSERT INTO todos VALUES (1)'), false);
  });

  it('rejects WITH-prefixed statements upfront', () => {
    // Conservative — we don't try to parse WITH ... SELECT vs WITH ... DML.
    assert.equal(isSelectOnly('WITH x AS (SELECT 1) SELECT * FROM x'), false);
  });
});
