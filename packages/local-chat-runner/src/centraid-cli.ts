#!/usr/bin/env node
/*
 * `centraid` CLI — exposed to codex (and other shell-capable agents) as
 * a small subprocess they invoke from their normal bash tool. Reads /
 * writes the active app's SQLite directly via `runQuery` /
 * `readAppSchema` from `@centraid/runtime-core` — no MCP server, no
 * network, no token plumbing.
 *
 * AppId scoping: the CLI opens `./data.sqlite` (cwd-relative). The
 * adapter spawns codex with `-C <appsDir>/<id>` so the working
 * directory IS the per-app data dir. The model cannot escape the scope
 * because it never names the appId — there's no `--app` flag.
 *
 * Output: JSON on stdout for tool results (so the agent can parse them
 * predictably) plus a short human-readable summary on stderr so the user
 * watching the chat log can follow along.
 *
 * Subcommands:
 *   centraid sql describe
 *   centraid sql read "SELECT ..."
 *   centraid sql write "INSERT ..." | "UPDATE ..." | "DELETE ..." | "REPLACE ..."
 *   centraid --help
 *
 * Exit codes:
 *   0  — success
 *   1  — runtime / SQL error
 *   2  — bad usage (missing arg, unknown subcommand)
 *   64 — refused (e.g. write SQL passed to `sql read`)
 */

import path from 'node:path';
import { readAppSchema, runQuery, RunQueryError } from '@centraid/runtime-core';

const SELECT_ROW_CAP = 200;

function isSelectOnly(sql: string): boolean {
  const stripped = sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .trim();
  if (!stripped) return false;
  const first = stripped.match(/^([A-Za-z]+)/)?.[1]?.toUpperCase();
  if (first !== 'SELECT' && first !== 'EXPLAIN') return false;
  return !/\b(insert|update|delete|drop|alter|create|replace|attach|detach|vacuum|reindex|pragma)\b/i.test(
    stripped,
  );
}

function isWriteDml(sql: string): boolean {
  const stripped = sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .trim();
  if (!stripped) return false;
  const first = stripped.match(/^([A-Za-z]+)/)?.[1]?.toUpperCase();
  if (first !== 'INSERT' && first !== 'UPDATE' && first !== 'DELETE' && first !== 'REPLACE') {
    return false;
  }
  return !/\b(drop|alter|create|attach|detach|vacuum|reindex|pragma)\b/i.test(stripped);
}

function dataFile(): string {
  // CENTRAID_DATA_FILE override is useful for tests; production codex
  // adapter spawns with cwd=<appsDir>/<id>, so the default ./data.sqlite
  // is correct without an override.
  if (process.env.CENTRAID_DATA_FILE) return process.env.CENTRAID_DATA_FILE;
  return path.resolve(process.cwd(), 'data.sqlite');
}

function printJson(value: unknown): void {
  process.stdout.write(JSON.stringify(value) + '\n');
}

function refuse(message: string): never {
  process.stderr.write(`centraid: refused — ${message}\n`);
  process.exit(64);
}

function fail(message: string, code = 1): never {
  process.stderr.write(`centraid: ${message}\n`);
  process.exit(code);
}

function usage(): never {
  process.stderr.write(
    [
      'Usage:',
      '  centraid sql describe',
      '  centraid sql read "SELECT ..."',
      '  centraid sql write "INSERT/UPDATE/DELETE/REPLACE ..."',
      '',
      "The CLI operates on ./data.sqlite (the chat session's working",
      'directory). DDL (CREATE/ALTER/DROP) and PRAGMA are not allowed.',
      '',
    ].join('\n'),
  );
  process.exit(2);
}

function commandDescribe(): void {
  const schema = readAppSchema(dataFile());
  const compact = {
    schemaVersion: schema.schemaVersion,
    tables: schema.tables.map((t) => ({
      name: t.name,
      columns: t.columns.map((c) => ({
        name: c.name,
        type: c.type,
        notnull: c.notnull,
        pk: c.pk,
      })),
    })),
    views: schema.views.map((v) => v.name),
    indexes: schema.indexes.map((i) => ({ name: i.name, table: i.tbl_name })),
  };
  printJson(compact);
}

function commandRead(sql: string): void {
  if (!isSelectOnly(sql)) {
    refuse('only SELECT (or EXPLAIN) statements are allowed in `sql read`.');
  }
  try {
    const result = runQuery(dataFile(), sql);
    if (result.kind !== 'rows') {
      fail('expected SELECT result; got an exec result.', 1);
    }
    const trimmed = result.rows.slice(0, SELECT_ROW_CAP);
    printJson({
      columns: result.columns,
      rows: trimmed,
      totalRows: result.rows.length,
      truncated: result.rows.length > trimmed.length,
      durationMs: result.durationMs,
    });
  } catch (err) {
    if (err instanceof RunQueryError) fail(`${err.code}: ${err.message}`);
    fail(err instanceof Error ? err.message : String(err));
  }
}

function commandWrite(sql: string): void {
  if (!isWriteDml(sql)) {
    refuse(
      'only INSERT/UPDATE/DELETE/REPLACE are allowed in `sql write`; DDL and PRAGMA are refused.',
    );
  }
  try {
    const result = runQuery(dataFile(), sql);
    if (result.kind !== 'exec') {
      fail('expected exec result; got rows.', 1);
    }
    printJson({
      rowsAffected: result.rowsAffected,
      lastInsertRowid:
        typeof result.lastInsertRowid === 'bigint'
          ? result.lastInsertRowid.toString()
          : result.lastInsertRowid,
      durationMs: result.durationMs,
    });
  } catch (err) {
    if (err instanceof RunQueryError) fail(`${err.code}: ${err.message}`);
    fail(err instanceof Error ? err.message : String(err));
  }
}

function main(argv: string[]): void {
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') usage();
  const top = argv[0];
  if (top !== 'sql') {
    process.stderr.write(`centraid: unknown command "${top}"\n`);
    usage();
  }
  const sub = argv[1];
  if (!sub) usage();
  if (sub === 'describe') {
    if (argv.length > 2) {
      process.stderr.write('centraid: `sql describe` takes no arguments\n');
      process.exit(2);
    }
    commandDescribe();
    return;
  }
  if (sub === 'read') {
    const sql = argv[2];
    if (!sql) {
      process.stderr.write('centraid: `sql read` requires a SQL statement\n');
      process.exit(2);
    }
    commandRead(sql);
    return;
  }
  if (sub === 'write') {
    const sql = argv[2];
    if (!sql) {
      process.stderr.write('centraid: `sql write` requires a SQL statement\n');
      process.exit(2);
    }
    commandWrite(sql);
    return;
  }
  process.stderr.write(`centraid: unknown subcommand "${sub}"\n`);
  usage();
}

main(process.argv.slice(2));
