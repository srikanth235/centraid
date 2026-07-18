#!/usr/bin/env node

import { performance } from 'node:perf_hooks';

const started = performance.now();
const { DatabaseSync } = await import('node:sqlite');
const importedMs = performance.now() - started;
const db = new DatabaseSync(':memory:');
db.exec(
  'PRAGMA journal_mode = WAL; CREATE TABLE probe (id INTEGER PRIMARY KEY, value TEXT NOT NULL);',
);
const insert = db.prepare('INSERT INTO probe(value) VALUES (?)');
const read = db.prepare('SELECT value FROM probe WHERE id = ?');
const writes = 10_000;
const writeStarted = performance.now();
db.exec('BEGIN IMMEDIATE');
for (let index = 0; index < writes; index += 1) insert.run(`runtime-${index}`);
db.exec('COMMIT');
const writeMs = performance.now() - writeStarted;
const readStarted = performance.now();
for (let index = 1; index <= writes; index += 1) {
  if (read.get(index)?.value !== `runtime-${index - 1}`) throw new Error('SQLite read mismatch');
}
const readMs = performance.now() - readStarted;
const report = {
  schema: 'centraid-runtime-sqlite-probe/1',
  runtime: typeof Bun === 'undefined' ? 'node' : 'bun',
  version: typeof Bun === 'undefined' ? process.version : Bun.version,
  sqliteImportAndOpenMs: importedMs,
  transactionWrites: writes,
  transactionWriteMs: writeMs,
  pointReads: writes,
  pointReadMs: readMs,
  rssBytes: process.memoryUsage().rss,
};
db.close();
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
