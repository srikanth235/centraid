#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

const script = fileURLToPath(import.meta.url);

async function probeCurrentRuntime() {
  const runtime = typeof Bun === 'undefined' ? 'node' : 'bun';
  const version = typeof Bun === 'undefined' ? process.version : Bun.version;
  try {
    const started = performance.now();
    const { DatabaseSync } = await import('node:sqlite');
    const importedMs = performance.now() - started;
    const db = new DatabaseSync(':memory:');
    try {
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
      const transactionWriteMs = performance.now() - writeStarted;
      const readStarted = performance.now();
      for (let index = 1; index <= writes; index += 1) {
        if (read.get(index)?.value !== `runtime-${index - 1}`) {
          throw new Error('SQLite read mismatch');
        }
      }
      return {
        schema: 'centraid-runtime-sqlite-probe/1',
        runtime,
        version,
        compatible: true,
        sqliteImportAndOpenMs: importedMs,
        transactionWrites: writes,
        transactionWriteMs,
        pointReads: writes,
        pointReadMs: performance.now() - readStarted,
        rssBytes: process.memoryUsage().rss,
      };
    } finally {
      db.close();
    }
  } catch (error) {
    return {
      schema: 'centraid-runtime-sqlite-probe/1',
      runtime,
      version,
      compatible: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function runProbe(executable) {
  const result = spawnSync(executable, [script, '--runtime-only'], {
    encoding: 'utf8',
    env: process.env,
  });
  if (result.error) {
    return {
      schema: 'centraid-runtime-sqlite-probe/1',
      runtime: executable === process.execPath ? 'node' : 'bun',
      version: 'unavailable',
      compatible: false,
      error: result.error.message,
    };
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    return {
      schema: 'centraid-runtime-sqlite-probe/1',
      runtime: executable === process.execPath ? 'node' : 'bun',
      version: 'unknown',
      compatible: false,
      error: result.stderr.trim() || `probe exited ${result.status ?? 'without a status'}`,
    };
  }
}

function comparisonEntry(probe) {
  if (!probe.compatible) {
    return { version: probe.version, compatible: false, error: probe.error };
  }
  return {
    version: probe.version,
    sqliteImportAndOpenMs: probe.sqliteImportAndOpenMs,
    transactionWrites10000Ms: probe.transactionWriteMs,
    reads10000Ms: probe.pointReadMs,
    rssBytes: probe.rssBytes,
    compatible: true,
  };
}

if (process.argv.includes('--runtime-only')) {
  process.stdout.write(`${JSON.stringify(await probeCurrentRuntime(), null, 2)}\n`);
} else {
  const node = runProbe(process.execPath);
  const bun = runProbe(process.env.BUN_BIN || 'bun');
  const comparable = node.compatible && bun.compatible;
  const report = {
    schema: 'centraid-gateway-runtime-comparison/1',
    generatedAt: new Date().toISOString().slice(0, 10),
    node: comparisonEntry(node),
    bun: comparisonEntry(bun),
    decision: comparable ? 're-evaluate' : 'no-go',
    reason: comparable
      ? 'Both runtimes pass the required node:sqlite compatibility probe; run the full gateway durability and performance gates before migration.'
      : 'A like-for-like gateway comparison is invalid until Bun supports the required node:sqlite API and passes the durability suite.',
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}
