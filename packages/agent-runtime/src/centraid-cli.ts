#!/usr/bin/env node
/*
 * `centraid` CLI — still shipped as a human-facing binary so authors and
 * scripts can poke at an app's `data.sqlite` from a shell. Agents now call
 * the same operations via in-process tool registrations (`centraid_sql_*`)
 * declared by the codex / claude adapters; both paths share the underlying
 * implementation in `@centraid/runtime-core`'s `sql-ops.ts`.
 *
 * AppId scoping: the CLI opens files relative to its cwd. There is no
 * `--workspace` flag — the caller must `cd` into the app's data dir.
 *
 * Output: JSON on stdout for tool results plus a short human-readable
 * summary on stderr.
 *
 * Subcommands:
 *   centraid sql describe
 *   centraid sql read "SELECT ..."
 *   centraid sql write "INSERT ..." | "UPDATE ..." | "DELETE ..." | "REPLACE ..."
 *   centraid preview snapshot
 *   centraid --help
 *
 * Exit codes:
 *   0  — success
 *   1  — runtime / SQL error
 *   2  — bad usage (missing arg, unknown subcommand)
 *   64 — refused (e.g. write SQL passed to `sql read`)
 */

import path from 'node:path';
import { statSync } from 'node:fs';
import {
  describeOp,
  makeActivityDbProvider,
  readActiveCodeDir,
  readOp,
  writeOp,
  SqlOpRefusal,
  RunQueryError,
} from '@centraid/runtime-core';
import { runAutomationLocal, type LocalRunnerKind } from './run-automation-local.js';

function dataFile(): string {
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
      '  centraid preview snapshot',
      '  centraid run-automation <appId> <name> [--runner codex|claude-code] [--timeout-ms <n>]',
      '',
      'The CLI operates relative to the current working directory.',
      'DDL (CREATE/ALTER/DROP) and PRAGMA are not allowed in `sql` subcommands.',
      '',
      '`run-automation` is the headless entry point invoked by host schedulers',
      '(launchd / Task Scheduler / systemd timer). It loads the manifest at',
      '`<cwd>/automations/<name>.json`, spawns the appropriate CLI per ctx.tool',
      'batch, and writes a run record to stdout as JSON. Exits 0 on success,',
      'non-zero on failure.',
      '',
    ].join('\n'),
  );
  process.exit(2);
}

function commandDescribe(): void {
  try {
    printJson(describeOp({ dataFile: dataFile() }));
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
}

function commandRead(sql: string): void {
  try {
    printJson(readOp({ dataFile: dataFile(), sql }));
  } catch (err) {
    if (err instanceof SqlOpRefusal) {
      // CLI surface phrasing mirrors the historical error message format.
      refuse('only SELECT (or EXPLAIN) statements are allowed in `sql read`.');
    }
    if (err instanceof RunQueryError) fail(`${err.code}: ${err.message}`);
    fail(err instanceof Error ? err.message : String(err));
  }
}

const PREVIEW_SNAPSHOT_REL = path.join('.preview', 'snapshot.png');

function commandPreviewSnapshot(): void {
  const abs = path.resolve(process.cwd(), PREVIEW_SNAPSHOT_REL);
  try {
    const stat = statSync(abs);
    printJson({
      path: abs,
      exists: true,
      sizeBytes: stat.size,
      mtimeMs: stat.mtimeMs,
      ageMs: Date.now() - stat.mtimeMs,
    });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      printJson({ path: abs, exists: false });
      return;
    }
    fail(err instanceof Error ? err.message : String(err));
  }
}

function commandWrite(sql: string): void {
  try {
    printJson(writeOp({ dataFile: dataFile(), sql }));
  } catch (err) {
    if (err instanceof SqlOpRefusal) {
      refuse(
        'only INSERT/UPDATE/DELETE/REPLACE are allowed in `sql write`; DDL and PRAGMA are refused.',
      );
    }
    if (err instanceof RunQueryError) fail(`${err.code}: ${err.message}`);
    fail(err instanceof Error ? err.message : String(err));
  }
}

interface ParsedRunAutomation {
  appId: string;
  name: string;
  runner: LocalRunnerKind;
  timeoutMs?: number;
}

function parseRunAutomationArgs(args: string[]): ParsedRunAutomation {
  if (args.length < 2) {
    process.stderr.write('centraid: `run-automation` requires <appId> <name>\n');
    process.exit(2);
  }
  const appId = args[0]!;
  const name = args[1]!;
  let runner: LocalRunnerKind = 'codex';
  let timeoutMs: number | undefined;
  for (let i = 2; i < args.length; i++) {
    const flag = args[i];
    if (flag === '--runner') {
      const value = args[++i];
      if (value !== 'codex' && value !== 'claude-code') {
        process.stderr.write(
          `centraid: --runner must be "codex" or "claude-code", got "${value}"\n`,
        );
        process.exit(2);
      }
      runner = value;
    } else if (flag === '--timeout-ms') {
      const value = Number(args[++i]);
      if (!Number.isFinite(value) || value <= 0) {
        process.stderr.write(
          `centraid: --timeout-ms must be a positive number, got "${args[i]}"\n`,
        );
        process.exit(2);
      }
      timeoutMs = value;
    } else {
      process.stderr.write(`centraid: unknown flag "${flag}"\n`);
      process.exit(2);
    }
  }
  return { appId, name, runner, ...(timeoutMs !== undefined ? { timeoutMs } : {}) };
}

async function commandRunAutomation(parsed: ParsedRunAutomation): Promise<never> {
  const appDir = process.cwd();
  // The OS scheduler freezes `cwd` into its plist/service file at
  // register-time, so the cron'd path is the persistent app root and
  // must survive every subsequent publish. Resolve the active version
  // here at fire-time so we load the manifest + handler from the
  // currently-deployed version, not from a stale baked-in path.
  // Falls back to `appDir` for path-registered apps (no current.json).
  const codeDir = await readActiveCodeDir(appDir);
  // This is the OS-scheduler-spawned path — no in-process gateway
  // handle. The run audit must land in the SAME automations DB the
  // desktop reads, so the OS scheduler bakes `CENTRAID_AUTOMATION_DB`
  // into the launchd plist / systemd unit / Task Scheduler artifact.
  // Fall back to `<appDir>/centraid-activity.sqlite` for a bare CLI
  // invocation.
  const automationDbPath =
    process.env.CENTRAID_AUTOMATION_DB ?? path.join(appDir, 'centraid-activity.sqlite');
  const automationDb = makeActivityDbProvider(automationDbPath);
  try {
    const { outcome, record } = await runAutomationLocal({
      appId: parsed.appId,
      appDir,
      codeDir,
      automationName: parsed.name,
      runner: parsed.runner,
      automationDb,
      ...(parsed.timeoutMs !== undefined ? { timeoutMs: parsed.timeoutMs } : {}),
      onLog: (level, msg) => {
        process.stderr.write(`[mock-llm:${level}] ${msg}\n`);
      },
    });
    // Run record is the structured stdout. Human-friendly summary on
    // stderr so the OS scheduler's log shows the gist at a glance.
    printJson(record);
    process.stderr.write(
      `centraid: automation ${record.appId}/${record.automationName} ${record.ok ? 'ok' : 'FAILED'} ` +
        `in ${record.durationMs}ms (${record.toolBatches} tool batches, ${record.agentCalls} agent calls)\n`,
    );
    process.exit(outcome.ok ? 0 : 1);
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
}

function main(argv: string[]): void {
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') usage();
  const top = argv[0];
  if (top === 'run-automation') {
    const parsed = parseRunAutomationArgs(argv.slice(1));
    void commandRunAutomation(parsed);
    return;
  }
  if (top === 'preview') {
    const sub = argv[1];
    if (sub !== 'snapshot') {
      process.stderr.write(`centraid: unknown preview subcommand "${sub ?? ''}"\n`);
      usage();
    }
    if (argv.length > 2) {
      process.stderr.write('centraid: `preview snapshot` takes no arguments\n');
      process.exit(2);
    }
    commandPreviewSnapshot();
    return;
  }
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
