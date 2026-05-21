import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  GATEWAY_MIGRATIONS,
  CHAT_MIGRATIONS,
  AUTOMATION_MIGRATIONS,
  openGatewayDb,
  openChatDb,
  openAutomationDb,
  makeGatewayDbProvider,
  makeChatDbProvider,
  makeAutomationDbProvider,
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

describe('openChatDb (chat_sessions + chat_messages)', () => {
  it('advances PRAGMA user_version to CHAT_MIGRATIONS.length on a fresh DB', () => {
    const path = freshDbPath();
    openChatDb(path).close();
    assert.equal(userVersion(path), CHAT_MIGRATIONS.length);
  });

  it('creates exactly the chat_sessions + chat_messages tables', () => {
    const path = freshDbPath();
    openChatDb(path).close();
    assert.deepEqual(tableNames(path), ['chat_messages', 'chat_sessions']);
  });

  it('chat_sessions has NO foreign key (user_id is application-enforced)', () => {
    // `users` lives in a different file; SQLite has no cross-file FKs, so
    // chat_sessions must not declare one.
    const path = freshDbPath();
    openChatDb(path).close();
    const db = new DatabaseSync(path);
    try {
      const fks = db.prepare(`PRAGMA foreign_key_list('chat_sessions')`).all();
      assert.equal(fks.length, 0, 'chat_sessions should declare no foreign keys');
    } finally {
      db.close();
    }
  });

  it('FK cascade deletes messages when their session is removed', () => {
    const path = freshDbPath();
    const db = openChatDb(path);
    try {
      db.prepare(
        `INSERT INTO chat_sessions (id, user_id, origin_app_id, title, mode, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run('s1', 'u1', 'todos', 'hi', 'full', Date.now(), Date.now());
      db.prepare(
        `INSERT INTO chat_messages (session_id, idx, app_id, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run('s1', 0, 'todos', '{"kind":"user","text":"x"}', Date.now());

      db.prepare(`DELETE FROM chat_sessions WHERE id = ?`).run('s1');

      const messages = db.prepare(`SELECT COUNT(*) AS n FROM chat_messages`).get() as { n: number };
      assert.equal(Number(messages.n), 0);
    } finally {
      db.close();
    }
  });

  it('throws when the DB is at a newer version than this build supports', () => {
    const path = freshDbPath();
    openChatDb(path).close();
    const db = new DatabaseSync(path);
    db.exec(`PRAGMA user_version = ${CHAT_MIGRATIONS.length + 1}`);
    db.close();
    assert.throws(() => openChatDb(path), /newer|update centraid/i);
  });
});

describe('openAutomationDb (mirror + run audit)', () => {
  it('advances PRAGMA user_version to AUTOMATION_MIGRATIONS.length on a fresh DB', () => {
    const path = freshDbPath();
    openAutomationDb(path).close();
    assert.equal(userVersion(path), AUTOMATION_MIGRATIONS.length);
    assert.equal(AUTOMATION_MIGRATIONS.length, 2);
  });

  it('creates the automations mirror + run-audit tables', () => {
    const path = freshDbPath();
    openAutomationDb(path).close();
    assert.deepEqual(tableNames(path), [
      'automation_run_nodes',
      'automation_runs',
      'automation_state',
      'automations',
    ]);
  });

  it('automation_run_nodes cascades off automation_runs; parent_run_id is SET NULL', () => {
    const path = freshDbPath();
    openAutomationDb(path).close();
    const db = new DatabaseSync(path);
    try {
      const nodeFk = (
        db.prepare(`PRAGMA foreign_key_list('automation_run_nodes')`).all() as Array<{
          table: string;
          on_delete: string;
        }>
      ).find((f) => f.table === 'automation_runs');
      assert.ok(nodeFk, 'expected FK on automation_run_nodes.run_id → automation_runs.run_id');
      assert.equal(nodeFk.on_delete, 'CASCADE');

      const parentFk = (
        db.prepare(`PRAGMA foreign_key_list('automation_runs')`).all() as Array<{
          table: string;
          on_delete: string;
        }>
      ).find((f) => f.table === 'automation_runs');
      assert.ok(parentFk, 'expected self-FK on automation_runs.parent_run_id');
      assert.equal(parentFk.on_delete, 'SET NULL');
    } finally {
      db.close();
    }
  });

  it('re-opening an already-migrated DB is a no-op', () => {
    const path = freshDbPath();
    openAutomationDb(path).close();
    const before = userVersion(path);
    openAutomationDb(path).close();
    assert.equal(userVersion(path), before);
  });

  it('throws when the DB is at a newer version than this build supports', () => {
    const path = freshDbPath();
    openAutomationDb(path).close();
    const db = new DatabaseSync(path);
    db.exec(`PRAGMA user_version = ${AUTOMATION_MIGRATIONS.length + 1}`);
    db.close();
    assert.throws(() => openAutomationDb(path), /newer|update centraid/i);
  });
});

describe('lazy providers', () => {
  it('opens the DB once and reuses the handle for subsequent calls', () => {
    for (const make of [makeGatewayDbProvider, makeChatDbProvider, makeAutomationDbProvider]) {
      const provider = make(freshDbPath());
      const a = provider();
      const b = provider();
      assert.equal(a, b);
      a.close();
    }
  });

  it('does not touch the filesystem until the first call', () => {
    for (const make of [makeGatewayDbProvider, makeChatDbProvider, makeAutomationDbProvider]) {
      const path = freshDbPath();
      make(path);
      assert.equal(existsSync(path), false);
    }
  });
});
