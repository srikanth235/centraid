import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  GATEWAY_MIGRATIONS,
  RUNTIME_MIGRATIONS,
  openGatewayDb,
  openRuntimeDb,
  makeGatewayDbProvider,
  makeRuntimeDbProvider,
} from './gateway-db.js';

function freshDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'centraid-db-'));
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

function tableNames(path: string): string[] {
  const db = new DatabaseSync(path);
  try {
    return (
      db.prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`).all() as Array<{
        name: string;
      }>
    )
      .map((t) => t.name)
      .filter((n) => !n.startsWith('sqlite_'));
  } finally {
    db.close();
  }
}

describe('openGatewayDb (users + user_prefs)', () => {
  it('advances PRAGMA user_version to GATEWAY_MIGRATIONS.length on a fresh DB', () => {
    const path = freshDbPath();
    openGatewayDb(path).close();
    assert.equal(userVersion(path), GATEWAY_MIGRATIONS.length);
  });

  it('creates exactly the users + user_prefs tables', () => {
    const path = freshDbPath();
    openGatewayDb(path).close();
    assert.deepEqual(tableNames(path), ['user_prefs', 'users']);
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
    db.exec(`PRAGMA user_version = ${GATEWAY_MIGRATIONS.length + 1}`);
    db.close();
    assert.throws(() => openGatewayDb(path), /newer|update centraid/i);
  });

  it('FK cascade deletes a user’s prefs when the user is removed', () => {
    // Confirms `PRAGMA foreign_keys=ON` is in effect — without it sqlite
    // ignores the FK clause. user_prefs lives in the same file as users,
    // so this cascade is a real foreign key.
    const path = freshDbPath();
    const db = openGatewayDb(path);
    try {
      db.prepare(`INSERT INTO users (id, created_at) VALUES (?, ?)`).run('u1', Date.now());
      db.prepare(`INSERT INTO user_prefs (user_id, key, value) VALUES (?, ?, ?)`).run(
        'u1',
        'theme',
        JSON.stringify('dark'),
      );
      db.prepare(`DELETE FROM users WHERE id = ?`).run('u1');
      const prefs = db.prepare(`SELECT COUNT(*) AS n FROM user_prefs`).get() as { n: number };
      assert.equal(Number(prefs.n), 0);
    } finally {
      db.close();
    }
  });
});

describe('openRuntimeDb (per-app chat_sessions + run ledger)', () => {
  it('advances PRAGMA user_version to RUNTIME_MIGRATIONS.length on a fresh DB', () => {
    const path = freshDbPath();
    openRuntimeDb(path).close();
    assert.equal(userVersion(path), RUNTIME_MIGRATIONS.length);
    assert.equal(RUNTIME_MIGRATIONS.length, 1);
  });

  it('creates chat_sessions + the run ledger (no automations table)', () => {
    // Issue #91: automation definitions live on disk, not in SQLite.
    const path = freshDbPath();
    openRuntimeDb(path).close();
    assert.deepEqual(tableNames(path), ['automation_state', 'chat_sessions', 'run_nodes', 'runs']);
  });

  it('chat_sessions has NO foreign key (user_id is application-enforced)', () => {
    // `users` lives in the separate gateway file; SQLite has no cross-file
    // FKs, so chat_sessions must not declare one.
    const path = freshDbPath();
    openRuntimeDb(path).close();
    const db = new DatabaseSync(path);
    try {
      const fks = db.prepare(`PRAGMA foreign_key_list('chat_sessions')`).all();
      assert.equal(fks.length, 0, 'chat_sessions should declare no foreign keys');
    } finally {
      db.close();
    }
  });

  it('run_nodes cascades off runs; chat_session_id cascades; parent_run_id has no FK', () => {
    // `parent_run_id` is a plain column — a cross-app `ctx.invoke` sub-run's
    // parent lives in a different app's file and a SQLite FK can't span files.
    const path = freshDbPath();
    openRuntimeDb(path).close();
    const db = new DatabaseSync(path);
    try {
      const nodeFk = (
        db.prepare(`PRAGMA foreign_key_list('run_nodes')`).all() as Array<{
          table: string;
          on_delete: string;
        }>
      ).find((f) => f.table === 'runs');
      assert.ok(nodeFk, 'expected FK on run_nodes.run_id → runs.id');
      assert.equal(nodeFk.on_delete, 'CASCADE');

      const runFks = db.prepare(`PRAGMA foreign_key_list('runs')`).all() as Array<{
        table: string;
        on_delete: string;
      }>;
      assert.equal(
        runFks.find((f) => f.table === 'runs'),
        undefined,
        'runs.parent_run_id must NOT declare a self-FK',
      );

      const chatFk = runFks.find((f) => f.table === 'chat_sessions');
      assert.ok(chatFk, 'expected FK on runs.chat_session_id → chat_sessions.id');
      assert.equal(chatFk.on_delete, 'CASCADE');
    } finally {
      db.close();
    }
  });

  it('deleting a chat session cascades its runs and their run_nodes', () => {
    const path = freshDbPath();
    const db = openRuntimeDb(path);
    try {
      const now = Date.now();
      db.prepare(
        `INSERT INTO chat_sessions (id, user_id, title, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run('s1', 'u1', 'hi', now, now);
      db.prepare(
        `INSERT INTO runs (id, kind, chat_session_id, trigger, started_at)
         VALUES (?, 'chat', ?, 'interactive', ?)`,
      ).run('r1', 's1', now);
      db.prepare(
        `INSERT INTO run_nodes (id, run_id, ordinal, kind, ok, started_at)
         VALUES (?, ?, 0, 'step', 1, ?)`,
      ).run('n1', 'r1', now);

      db.prepare(`DELETE FROM chat_sessions WHERE id = ?`).run('s1');

      const runs = db.prepare(`SELECT COUNT(*) AS n FROM runs`).get() as { n: number };
      const nodes = db.prepare(`SELECT COUNT(*) AS n FROM run_nodes`).get() as { n: number };
      assert.equal(Number(runs.n), 0);
      assert.equal(Number(nodes.n), 0);
    } finally {
      db.close();
    }
  });

  it('re-opening an already-migrated DB is a no-op', () => {
    const path = freshDbPath();
    openRuntimeDb(path).close();
    const before = userVersion(path);
    openRuntimeDb(path).close();
    assert.equal(userVersion(path), before);
  });

  it('throws when the DB is at a newer version than this build supports', () => {
    const path = freshDbPath();
    openRuntimeDb(path).close();
    const db = new DatabaseSync(path);
    db.exec(`PRAGMA user_version = ${RUNTIME_MIGRATIONS.length + 1}`);
    db.close();
    assert.throws(() => openRuntimeDb(path), /newer|update centraid/i);
  });
});

describe('lazy providers', () => {
  it('opens the DB once and reuses the handle for subsequent calls', () => {
    for (const make of [makeGatewayDbProvider, makeRuntimeDbProvider]) {
      const provider = make(freshDbPath());
      const a = provider();
      const b = provider();
      assert.equal(a, b);
      a.close();
    }
  });

  it('does not touch the filesystem until the first call', () => {
    for (const make of [makeGatewayDbProvider, makeRuntimeDbProvider]) {
      const path = freshDbPath();
      make(path);
      assert.equal(existsSync(path), false);
    }
  });
});
