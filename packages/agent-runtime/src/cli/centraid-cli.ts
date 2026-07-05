#!/usr/bin/env node
/*
 * `centraid` CLI — shipped as a binary the builder agent's shell can call
 * by bare name (the session injects this package's dist dir onto PATH).
 *
 * The `sql` subcommands died with the per-app data.sqlite (issue #286
 * phase 2) — data questions ride the in-process vault-register tools
 * (`vault_sql` / `vault_invoke`); there is no per-app database for a
 * shell to poke.
 *
 * Output: JSON on stdout plus a short human-readable summary on stderr.
 *
 * Subcommands:
 *   centraid preview snapshot
 *   centraid --help
 *
 * Exit codes:
 *   0  — success
 *   1  — runtime error
 *   2  — bad usage (missing arg, unknown subcommand)
 */

import path from 'node:path';
import { statSync } from 'node:fs';

function printJson(value: unknown): void {
  process.stdout.write(JSON.stringify(value) + '\n');
}

function fail(message: string, code = 1): never {
  process.stderr.write(`centraid: ${message}\n`);
  process.exit(code);
}

function usage(): never {
  process.stderr.write(
    [
      'Usage:',
      '  centraid preview snapshot',
      '',
      'The CLI operates relative to the current working directory.',
      '',
    ].join('\n'),
  );
  process.exit(2);
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

function main(argv: string[]): void {
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') usage();
  const top = argv[0];
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
  process.stderr.write(`centraid: unknown command "${top}"\n`);
  usage();
}

main(process.argv.slice(2));
