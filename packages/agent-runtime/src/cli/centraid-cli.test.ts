import { tempDir } from '@centraid/test-kit/temp-dir';
/*
 * End-to-end smoke test for the centraid CLI bin, invoked as a subprocess
 * (using the built dist/cli/centraid-cli.js). The `sql` subcommands died
 * with the per-app data.sqlite (issue #286 phase 2); what remains is the
 * builder-session helper surface (`preview snapshot`) and its exit codes.
 *
 * The test depends on a prior `bun run build` for this package; turbo
 * configures `test` to run after `build` so the dist file exists.
 */

import { afterAll, beforeAll, expect, test } from 'vitest';
import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// This test lives at src/cli/; the built CLI is at <pkg>/dist/cli/ (rootDir
// src mirrors into dist). Two levels up from src/cli reaches the package root.
const CLI_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'dist',
  'cli',
  'centraid-cli.js',
);

let workspace: string;

beforeAll(async () => {
  workspace = await tempDir('centraid-cli-test-');
});

afterAll(async () => {
  if (workspace) await fs.rm(workspace, { recursive: true, force: true });
});

function runCli(...args: string[]): { stdout: string; stderr: string; code: number } {
  const result = spawnSync(process.execPath, [CLI_PATH, ...args], {
    cwd: workspace,
    encoding: 'utf8',
  });
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    code: typeof result.status === 'number' ? result.status : -1,
  };
}

test('the retired sql subcommand exits with usage error', () => {
  const r = runCli('sql', 'read', 'SELECT 1');
  expect(r.code).toBe(2);
  expect(r.stderr).toMatch(/unknown command "sql"/);
});

test('unknown command exits with usage error', () => {
  const r = runCli('gibberish');
  expect(r.code).toBe(2);
  expect(r.stderr).toMatch(/unknown command/);
});

test('preview snapshot reports exists:false when the file is missing', () => {
  const r = runCli('preview', 'snapshot');
  expect(r.code).toBe(0);
  const parsed = JSON.parse(r.stdout) as { path: string; exists: boolean };
  expect(parsed.exists).toBe(false);
  expect(parsed.path).toMatch(/\.preview\/snapshot\.png$/);
});

test('preview snapshot returns size + age when the file exists', async () => {
  const dir = path.join(workspace, '.preview');
  await fs.mkdir(dir, { recursive: true });
  const png = path.join(dir, 'snapshot.png');
  await fs.writeFile(png, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const r = runCli('preview', 'snapshot');
  expect(r.code).toBe(0);
  const parsed = JSON.parse(r.stdout) as {
    path: string;
    exists: boolean;
    sizeBytes: number;
    mtimeMs: number;
    ageMs: number;
  };
  expect(parsed.exists).toBe(true);
  expect(parsed.sizeBytes).toBe(4);
  expect(parsed.mtimeMs > 0).toBeTruthy();
  expect(parsed.ageMs >= 0).toBeTruthy();
  await fs.rm(dir, { recursive: true, force: true });
});

test('preview with no subcommand exits with usage error', () => {
  const r = runCli('preview');
  expect(r.code).toBe(2);
  expect(r.stderr).toMatch(/unknown preview subcommand/);
});

test('preview snapshot rejects extra args', () => {
  const r = runCli('preview', 'snapshot', 'extra');
  expect(r.code).toBe(2);
  expect(r.stderr).toMatch(/takes no arguments/);
});
