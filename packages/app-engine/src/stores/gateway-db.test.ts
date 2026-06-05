import { describe, expect, it } from 'vitest';
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
    expect(userVersion(path)).toBe(GATEWAY_MIGRATIONS.length);
  });

  it('creates exactly the users + user_prefs tables', () => {
    const path = freshDbPath();
    openGatewayDb(path).close();
    expect(tableNames(path)).toEqual(['user_prefs', 'users']);
  });

  it('re-opening an already-migrated DB is a no-op', () => {
    const path = freshDbPath();
    openGatewayDb(path).close();
    const before = userVersion(path);
    openGatewayDb(path).close();
    expect(userVersion(path)).toBe(before);
  });

  it('throws when the DB is at a newer version than this build supports', () => {
    const path = freshDbPath();
    openGatewayDb(path).close();
    const db = new DatabaseSync(path);
    db.exec(`PRAGMA user_version = ${GATEWAY_MIGRATIONS.length + 1}`);
    db.close();
    expect(() => openGatewayDb(path)).toThrow(/newer|update centraid/i);
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
      expect(Number(prefs.n)).toBe(0);
    } finally {
      db.close();
    }
  });
});

describe('openRuntimeDb (per-app conversation ledger)', () => {
  it('advances PRAGMA user_version to RUNTIME_MIGRATIONS.length on a fresh DB', () => {
    const path = freshDbPath();
    openRuntimeDb(path).close();
    expect(userVersion(path)).toBe(RUNTIME_MIGRATIONS.length);
    expect(RUNTIME_MIGRATIONS.length).toBe(1);
  });

  it('creates conversations/turns/items/attachments + automation_state (no legacy tables)', () => {
    const path = freshDbPath();
    openRuntimeDb(path).close();
    expect(tableNames(path)).toEqual([
      'attachments',
      'automation_state',
      'conversations',
      'items',
      'turns',
    ]);
  });

  it('conversations has NO foreign key (user_id is application-enforced)', () => {
    // `users` lives in the separate gateway file; SQLite has no cross-file FKs.
    const path = freshDbPath();
    openRuntimeDb(path).close();
    const db = new DatabaseSync(path);
    try {
      expect(db.prepare(`PRAGMA foreign_key_list('conversations')`).all().length).toBe(0);
    } finally {
      db.close();
    }
  });

  it('turns→conversations and items→turns and attachments→items are CASCADE FKs', () => {
    const path = freshDbPath();
    openRuntimeDb(path).close();
    const db = new DatabaseSync(path);
    try {
      const fk = (table: string, parent: string) =>
        (
          db.prepare(`PRAGMA foreign_key_list('${table}')`).all() as Array<{
            table: string;
            on_delete: string;
          }>
        ).find((f) => f.table === parent);
      expect(fk('turns', 'conversations')?.on_delete).toBe('CASCADE');
      expect(fk('items', 'turns')?.on_delete).toBe('CASCADE');
      expect(fk('attachments', 'items')?.on_delete).toBe('CASCADE');
      // parent_turn_id is FK-free (cross-app sub-runs span files).
      const turnFks = db.prepare(`PRAGMA foreign_key_list('turns')`).all() as Array<{
        from: string;
      }>;
      expect(!turnFks.some((f) => f.from === 'parent_turn_id')).toBeTruthy();
    } finally {
      db.close();
    }
  });

  it('deleting a conversation cascades to its turns, items, and attachments', () => {
    const path = freshDbPath();
    const db = openRuntimeDb(path);
    try {
      const now = Date.now();
      db.prepare(
        `INSERT INTO conversations (id, kind, user_id, created_at, updated_at)
         VALUES ('c1', 'chat', 'u1', ?, ?)`,
      ).run(now, now);
      db.prepare(
        `INSERT INTO turns (id, conversation_id, seq, trigger, started_at)
         VALUES ('t1', 'c1', 0, 'interactive', ?)`,
      ).run(now);
      db.prepare(
        `INSERT INTO items (id, turn_id, ordinal, kind, role, text, started_at)
         VALUES ('i1', 't1', 0, 'message_in', 'user', 'hi', ?)`,
      ).run(now);
      db.prepare(
        `INSERT INTO attachments (id, item_id, hash, mime, size_bytes, created_at)
         VALUES ('a1', 'i1', 'deadbeef', 'image/png', 10, ?)`,
      ).run(now);

      db.prepare(`DELETE FROM conversations WHERE id = 'c1'`).run();
      for (const table of ['turns', 'items', 'attachments']) {
        const n = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
        expect(Number(n.n)).toBe(0);
      }
    } finally {
      db.close();
    }
  });

  it('CHECK constraints reject unknown conversation kind / turn trigger / item kind', () => {
    const path = freshDbPath();
    const db = openRuntimeDb(path);
    try {
      const now = Date.now();
      expect(() =>
        db
          .prepare(
            `INSERT INTO conversations (id, kind, user_id, created_at, updated_at) VALUES ('c', 'bogus', 'u', ?, ?)`,
          )
          .run(now, now),
      ).toThrow(/CHECK/i);
      db.prepare(
        `INSERT INTO conversations (id, kind, user_id, created_at, updated_at) VALUES ('c1','chat','u',?,?)`,
      ).run(now, now);
      expect(() =>
        db
          .prepare(
            `INSERT INTO turns (id, conversation_id, seq, trigger, started_at) VALUES ('t','c1',0,'bogus',?)`,
          )
          .run(now),
      ).toThrow(/CHECK/i);
      db.prepare(
        `INSERT INTO turns (id, conversation_id, seq, trigger, started_at) VALUES ('t1','c1',0,'interactive',?)`,
      ).run(now);
      expect(() =>
        db
          .prepare(
            `INSERT INTO items (id, turn_id, ordinal, kind, started_at) VALUES ('i','t1',0,'bogus',?)`,
          )
          .run(now),
      ).toThrow(/CHECK/i);
    } finally {
      db.close();
    }
  });

  it('re-opening an already-migrated DB is a no-op', () => {
    const path = freshDbPath();
    openRuntimeDb(path).close();
    const before = userVersion(path);
    openRuntimeDb(path).close();
    expect(userVersion(path)).toBe(before);
  });

  it('throws when the DB is at a newer version than this build supports', () => {
    const path = freshDbPath();
    openRuntimeDb(path).close();
    const db = new DatabaseSync(path);
    db.exec(`PRAGMA user_version = ${RUNTIME_MIGRATIONS.length + 1}`);
    db.close();
    expect(() => openRuntimeDb(path)).toThrow(/newer|update centraid/i);
  });
});

describe('lazy providers', () => {
  it('opens the DB once and reuses the handle for subsequent calls', () => {
    for (const make of [makeGatewayDbProvider, makeRuntimeDbProvider]) {
      const provider = make(freshDbPath());
      const a = provider();
      const b = provider();
      expect(a).toBe(b);
      a.close();
    }
  });

  it('does not touch the filesystem until the first call', () => {
    for (const make of [makeGatewayDbProvider, makeRuntimeDbProvider]) {
      const path = freshDbPath();
      make(path);
      expect(existsSync(path)).toBe(false);
    }
  });
});
