import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { trackChanges, touchedTablesFromChangeset } from './change-tracker.js';

function makeDb(): DatabaseSync {
  // In-memory db works fine for session tracking — sessions are
  // per-connection, not per-file, and the WAL pragma is irrelevant here.
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE todos(id INTEGER PRIMARY KEY, text TEXT);
    CREATE TABLE users(id INTEGER PRIMARY KEY, name TEXT);
    CREATE TABLE notes(id INTEGER PRIMARY KEY, body TEXT);
  `);
  return db;
}

describe('trackChanges', () => {
  it('returns empty when no writes happen between track() and extract()', () => {
    const db = makeDb();
    const tracker = trackChanges(db);
    assert.ok(tracker, 'tracker should be created');
    // No DML at all.
    assert.deepEqual(tracker.extract(), []);
    db.close();
  });

  it('returns the touched table for a single INSERT', () => {
    const db = makeDb();
    const tracker = trackChanges(db)!;
    db.exec("INSERT INTO todos(id, text) VALUES (1, 'hello')");
    assert.deepEqual(tracker.extract(), ['todos']);
    db.close();
  });

  it('returns deduplicated, sorted tables across mixed INSERT/UPDATE/DELETE', () => {
    const db = makeDb();
    const tracker = trackChanges(db)!;
    db.exec("INSERT INTO users(id, name) VALUES (1, 'alice'), (2, 'bob')");
    db.exec("INSERT INTO todos(id, text) VALUES (1, 'a'), (2, 'b')");
    db.exec("UPDATE todos SET text='c' WHERE id=1");
    db.exec('DELETE FROM users WHERE id=2');
    db.exec("INSERT INTO notes(id, body) VALUES (1, 'n')");
    assert.deepEqual(tracker.extract(), ['notes', 'todos', 'users']);
    db.close();
  });

  it('returns empty for read-only operations (sessions only capture writes)', () => {
    const db = makeDb();
    db.exec("INSERT INTO todos(id, text) VALUES (1, 'pre-existing')");
    const tracker = trackChanges(db)!;
    // Reads only; no writes captured.
    db.prepare('SELECT * FROM todos').all();
    db.prepare('SELECT COUNT(*) FROM todos').get();
    assert.deepEqual(tracker.extract(), []);
    db.close();
  });

  it('extract() is idempotent (second call returns empty after session closes)', () => {
    const db = makeDb();
    const tracker = trackChanges(db)!;
    db.exec("INSERT INTO todos(id, text) VALUES (1, 'x')");
    assert.deepEqual(tracker.extract(), ['todos']);
    // Session is closed after the first extract; we don't track further
    // writes against this handle.
    db.exec("INSERT INTO todos(id, text) VALUES (2, 'y')");
    assert.deepEqual(tracker.extract(), []);
    db.close();
  });

  it('close() before extract() is safe (cleanup path on error)', () => {
    const db = makeDb();
    const tracker = trackChanges(db)!;
    db.exec("INSERT INTO todos(id, text) VALUES (1, 'x')");
    tracker.close();
    // Extract after close — defined to return empty, not throw.
    assert.deepEqual(tracker.extract(), []);
    db.close();
  });

  it('handles tables without primary keys gracefully', () => {
    const db = new DatabaseSync(':memory:');
    // SQLite session extension requires a primary key on each tracked
    // table; tables without one are silently skipped. The tracker
    // should NOT throw — it just won't see the writes.
    db.exec('CREATE TABLE no_pk(x INTEGER, y TEXT)');
    db.exec('CREATE TABLE with_pk(id INTEGER PRIMARY KEY, text TEXT)');
    const tracker = trackChanges(db)!;
    db.exec("INSERT INTO no_pk(x, y) VALUES (1, 'a')");
    db.exec("INSERT INTO with_pk(id, text) VALUES (1, 'b')");
    // Only with_pk is captured.
    assert.deepEqual(tracker.extract(), ['with_pk']);
    db.close();
  });
});

describe('touchedTablesFromChangeset', () => {
  it('returns empty for an empty changeset blob', () => {
    assert.deepEqual(touchedTablesFromChangeset(new Uint8Array(0)), []);
  });

  it('enumerates tables from a real changeset against an empty replica', () => {
    // This is the path the production tracker takes — the replica has no
    // tables at all, but the filter still receives each table name.
    const src = makeDb();
    const sess = src.createSession();
    src.exec("INSERT INTO todos(id, text) VALUES (1, 'a')");
    src.exec("INSERT INTO users(id, name) VALUES (1, 'u')");
    const cs = sess.changeset();
    sess.close();
    src.close();
    assert.deepEqual(touchedTablesFromChangeset(cs).sort(), ['todos', 'users']);
  });
});
