import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  TRANSCRIPTS_MIGRATIONS,
  openTranscriptsDb,
  makeTranscriptsDbProvider,
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

describe('openTranscriptsDb (per-vault conversation ledger + run rollup, #280)', () => {
  it('advances PRAGMA user_version to TRANSCRIPTS_MIGRATIONS.length on a fresh DB', () => {
    const path = freshDbPath();
    openTranscriptsDb(path).close();
    expect(userVersion(path)).toBe(TRANSCRIPTS_MIGRATIONS.length);
    expect(TRANSCRIPTS_MIGRATIONS.length).toBe(1);
  });

  it('creates the ledger tables PLUS run_summary in ONE file (no legacy tables)', () => {
    const path = freshDbPath();
    openTranscriptsDb(path).close();
    expect(tableNames(path)).toEqual([
      'attachments',
      'automation_state',
      'conversations',
      'items',
      'run_summary',
      'turns',
    ]);
  });

  it('conversations has NO foreign key (user_id carries the vault owner party id)', () => {
    // The owner's party row lives in the vault's separate vault.db file;
    // SQLite has no cross-file FKs, so the scoping is application-enforced.
    const path = freshDbPath();
    openTranscriptsDb(path).close();
    const db = new DatabaseSync(path);
    try {
      expect(db.prepare(`PRAGMA foreign_key_list('conversations')`).all().length).toBe(0);
    } finally {
      db.close();
    }
  });

  it('turns→conversations and items→turns and attachments→items are CASCADE FKs', () => {
    const path = freshDbPath();
    openTranscriptsDb(path).close();
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
    const db = openTranscriptsDb(path);
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
    const db = openTranscriptsDb(path);
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
    openTranscriptsDb(path).close();
    const before = userVersion(path);
    openTranscriptsDb(path).close();
    expect(userVersion(path)).toBe(before);
  });

  it('throws when the DB is at a newer version than this build supports', () => {
    const path = freshDbPath();
    openTranscriptsDb(path).close();
    const db = new DatabaseSync(path);
    db.exec(`PRAGMA user_version = ${TRANSCRIPTS_MIGRATIONS.length + 1}`);
    db.close();
    expect(() => openTranscriptsDb(path)).toThrow(/newer|update centraid/i);
  });
});

describe('lazy provider', () => {
  it('opens the DB once and reuses the handle for subsequent calls', () => {
    const provider = makeTranscriptsDbProvider(freshDbPath());
    const a = provider();
    const b = provider();
    expect(a).toBe(b);
    a.close();
  });

  it('does not touch the filesystem until the first call', () => {
    const path = freshDbPath();
    makeTranscriptsDbProvider(path);
    expect(existsSync(path)).toBe(false);
  });
});
