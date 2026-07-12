import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openJournalDb, makeJournalDbProvider } from './gateway-db.js';

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

describe('openJournalDb (the conversation-ledger band of the vault journal)', () => {
  it('NEVER touches PRAGMA user_version — that belongs to the vault audit ladder', () => {
    // Fresh file: the ensure creates the ledger band and leaves the version 0.
    const path = freshDbPath();
    openJournalDb(path).close();
    expect(userVersion(path)).toBe(0);
  });

  it('is safe on a file the vault package already migrated (audit band intact)', () => {
    // Simulate a journal the vault's own ladder has stamped: a foreign table
    // plus a nonzero user_version. The ledger ensure must add its band
    // without disturbing either.
    const path = freshDbPath();
    const seed = new DatabaseSync(path);
    seed.exec(`CREATE TABLE consent_receipt (receipt_id TEXT PRIMARY KEY);`);
    seed.exec('PRAGMA user_version = 1');
    seed.close();
    openJournalDb(path).close();
    expect(userVersion(path)).toBe(1);
    expect(tableNames(path)).toContain('consent_receipt');
    expect(tableNames(path)).toContain('conversations');
  });

  it('creates the ledger tables + the run_summary VIEW in ONE file (no legacy tables)', () => {
    const path = freshDbPath();
    openJournalDb(path).close();
    expect(tableNames(path)).toEqual([
      'attachments',
      'automation_state',
      'conversations',
      'items',
      'turns',
    ]);
    const db = new DatabaseSync(path);
    try {
      const views = db
        .prepare(`SELECT name FROM sqlite_master WHERE type='view' ORDER BY name`)
        .all() as Array<{ name: string }>;
      expect(views.map((v) => v.name)).toEqual(['run_summary']);
    } finally {
      db.close();
    }
  });

  it('conversations has NO foreign key (user_id carries the vault owner party id)', () => {
    // The owner's party row lives in the vault's separate vault.db file;
    // SQLite has no cross-file FKs, so the scoping is application-enforced.
    const path = freshDbPath();
    openJournalDb(path).close();
    const db = new DatabaseSync(path);
    try {
      expect(db.prepare(`PRAGMA foreign_key_list('conversations')`).all().length).toBe(0);
    } finally {
      db.close();
    }
  });

  it('turns→conversations and items→turns and attachments→items are CASCADE FKs', () => {
    const path = freshDbPath();
    openJournalDb(path).close();
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
      // parent_turn_id is FK-free (a sub-run's parent may land in the same batch).
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
    const db = openJournalDb(path);
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
    const db = openJournalDb(path);
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

  it('re-opening an already-ensured DB is a no-op (rows survive)', () => {
    const path = freshDbPath();
    const first = openJournalDb(path);
    const now = Date.now();
    first
      .prepare(
        `INSERT INTO conversations (id, kind, user_id, created_at, updated_at)
         VALUES ('c1', 'chat', 'u1', ?, ?)`,
      )
      .run(now, now);
    first.close();
    const again = openJournalDb(path);
    try {
      const n = again.prepare('SELECT COUNT(*) AS n FROM conversations').get() as { n: number };
      expect(Number(n.n)).toBe(1);
    } finally {
      again.close();
    }
  });
});

describe('STRICT tables (issue #374 SQLite hardening)', () => {
  it('every ledger table is created STRICT', () => {
    const path = freshDbPath();
    openJournalDb(path).close();
    const db = new DatabaseSync(path);
    try {
      const rows = db
        .prepare(`SELECT name, sql FROM sqlite_master WHERE type = 'table'`)
        .all() as Array<{ name: string; sql: string }>;
      for (const table of ['conversations', 'turns', 'items', 'attachments', 'automation_state']) {
        const row = rows.find((r) => r.name === table);
        expect(row?.sql.trim().endsWith('STRICT')).toBe(true);
      }
    } finally {
      db.close();
    }
  });

  it('rejects a type-violating insert (STRICT enforcement)', () => {
    const path = freshDbPath();
    const db = openJournalDb(path);
    try {
      const now = Date.now();
      // turn_count is INTEGER; a non-numeric TEXT value violates STRICT.
      expect(() =>
        db
          .prepare(
            `INSERT INTO conversations (id, kind, user_id, turn_count, created_at, updated_at)
             VALUES ('c1', 'chat', 'u1', 'not-a-number', ?, ?)`,
          )
          .run(now, now),
      ).toThrow();
    } finally {
      db.close();
    }
  });
});

describe('lazy provider', () => {
  it('opens the DB once and reuses the handle for subsequent calls', () => {
    const provider = makeJournalDbProvider(freshDbPath());
    const a = provider();
    const b = provider();
    expect(a).toBe(b);
    a.close();
  });

  it('does not touch the filesystem until the first call', () => {
    const path = freshDbPath();
    makeJournalDbProvider(path);
    expect(existsSync(path)).toBe(false);
  });
});
