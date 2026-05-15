import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { MIGRATIONS, openGatewayDb, makeGatewayDbProvider } from './gateway-db.js';

function freshDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'centraid-gateway-db-'));
  return join(dir, 'db.sqlite');
}

function userVersion(path: string): number {
  const db = new DatabaseSync(path);
  try {
    const row = db.prepare('PRAGMA user_version').get() as { user_version: number };
    return row.user_version;
  } finally {
    db.close();
  }
}

describe('openGatewayDb', () => {
  it('advances PRAGMA user_version to MIGRATIONS.length on a fresh DB', () => {
    const path = freshDbPath();
    const db = openGatewayDb(path);
    db.close();
    assert.equal(userVersion(path), MIGRATIONS.length);
  });

  it('creates the four expected tables with FK constraints', () => {
    const path = freshDbPath();
    openGatewayDb(path).close();
    const db = new DatabaseSync(path);
    try {
      const tables = db
        .prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`)
        .all() as Array<{ name: string }>;
      const names = tables.map((t) => t.name).filter((n) => !n.startsWith('sqlite_'));
      assert.deepEqual(names.sort(), ['chat_messages', 'chat_sessions', 'user_prefs', 'users']);

      // Verify the FK from chat_sessions → users with ON DELETE CASCADE.
      const fks = db.prepare(`PRAGMA foreign_key_list('chat_sessions')`).all() as Array<{
        table: string;
        from: string;
        to: string;
        on_delete: string;
      }>;
      const userFk = fks.find((f) => f.table === 'users');
      assert.ok(userFk, 'expected FK on chat_sessions.user_id → users.id');
      assert.equal(userFk.from, 'user_id');
      assert.equal(userFk.to, 'id');
      assert.equal(userFk.on_delete, 'CASCADE');
    } finally {
      db.close();
    }
  });

  it('re-opening an already-migrated DB is a no-op', () => {
    const path = freshDbPath();
    openGatewayDb(path).close();
    const before = userVersion(path);
    openGatewayDb(path).close();
    assert.equal(userVersion(path), before);
  });

  it('throws when the DB is at a newer version than this build supports', () => {
    const path = freshDbPath();
    openGatewayDb(path).close();
    const db = new DatabaseSync(path);
    db.exec(`PRAGMA user_version = ${MIGRATIONS.length + 1}`);
    db.close();
    assert.throws(() => openGatewayDb(path), /newer|update centraid/i);
  });

  it('FK cascade actually deletes child rows when a user is removed', () => {
    // Confirms `PRAGMA foreign_keys=ON` is in effect on the connection
    // openGatewayDb returns — without that pragma sqlite ignores FK clauses.
    const path = freshDbPath();
    const db = openGatewayDb(path);
    try {
      db.prepare(`INSERT INTO users (id, created_at) VALUES (?, ?)`).run('u1', Date.now());
      db.prepare(`INSERT INTO user_prefs (user_id, key, value) VALUES (?, ?, ?)`).run(
        'u1',
        'theme',
        JSON.stringify('dark'),
      );
      db.prepare(
        `INSERT INTO chat_sessions (id, user_id, app_id, title, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run('s1', 'u1', 'todos', 'hi', Date.now(), Date.now());
      db.prepare(
        `INSERT INTO chat_messages (session_id, idx, payload_json, created_at)
         VALUES (?, ?, ?, ?)`,
      ).run('s1', 0, '{"kind":"user","text":"x"}', Date.now());

      db.prepare(`DELETE FROM users WHERE id = ?`).run('u1');

      const prefs = db.prepare(`SELECT COUNT(*) AS n FROM user_prefs`).get() as { n: number };
      const sessions = db.prepare(`SELECT COUNT(*) AS n FROM chat_sessions`).get() as { n: number };
      const messages = db.prepare(`SELECT COUNT(*) AS n FROM chat_messages`).get() as { n: number };
      assert.equal(Number(prefs.n), 0);
      assert.equal(Number(sessions.n), 0);
      assert.equal(Number(messages.n), 0);
    } finally {
      db.close();
    }
  });
});

describe('makeGatewayDbProvider', () => {
  it('opens the DB once and reuses the handle for subsequent calls', () => {
    const path = freshDbPath();
    const provider = makeGatewayDbProvider(path);
    const a = provider();
    const b = provider();
    // Same JS reference — provider cached the handle, didn't re-open.
    assert.equal(a, b);
    a.close();
  });

  it('does not touch the filesystem until the first call', () => {
    const path = freshDbPath();
    makeGatewayDbProvider(path);
    // Provider was never called, so openGatewayDb wasn't either, so sqlite
    // never created the file. (DatabaseSync creates on open by default;
    // the assertion is on the filesystem, not on PRAGMA reads.)
    assert.equal(existsSync(path), false);
  });
});
