import { DatabaseSync } from 'node:sqlite';

const [databasePath, rawWrites] = process.argv.slice(2);
if (!databasePath) throw new Error('database path is required');
const writes = Number(rawWrites ?? 100);
const db = new DatabaseSync(databasePath);
db.exec(
  'PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE perf_write (id INTEGER PRIMARY KEY, value TEXT NOT NULL) STRICT',
);
const insert = db.prepare('INSERT INTO perf_write (value) VALUES (?)');
for (let index = 0; index < writes; index += 1) {
  db.exec('BEGIN IMMEDIATE');
  insert.run(`value-${index}`);
  db.exec('COMMIT');
}
db.close();
