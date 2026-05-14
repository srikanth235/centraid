import { test, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import * as tar from 'tar';
import { ingestUpload, validateUploadEntry, UploadError } from './upload.ts';

/**
 * These tests target the policy directly via `validateUploadEntry`, the
 * pure function that backs the tar-filter callback inside `ingestUpload`.
 * Driving the full upload pipeline from a test surfaces a known tar +
 * node:stream/promises wrinkle: a synchronous throw inside the filter
 * callback escapes as an uncaughtException in addition to the pipeline
 * rejection. The function under test runs identical checks and gives the
 * test a deterministic, single-throw entry point.
 */

function expectReject(fn: () => void, code: UploadError['code'], msgPattern?: RegExp): void {
  let caught: unknown;
  try {
    fn();
  } catch (e) {
    caught = e;
  }
  assert.ok(caught instanceof UploadError, `expected UploadError, got ${caught}`);
  assert.equal(caught.code, code);
  if (msgPattern) assert.match(caught.message, msgPattern);
}

test('accepts allowed extensions', () => {
  validateUploadEntry('app.json', 'File');
  validateUploadEntry('index.html', 'File');
  validateUploadEntry('app.css', 'File');
  validateUploadEntry('app.js', 'File');
  validateUploadEntry('queries/list.js', 'File');
  validateUploadEntry('migrations/0001_init.sql', 'File');
  validateUploadEntry('assets/logo.svg', 'File');
  validateUploadEntry('queries', 'Directory'); // dirs always pass past the type check
});

test('rejects .ts (the new policy)', () => {
  expectReject(() => validateUploadEntry('queries/list.ts', 'File'), 'bad_extension', /\.ts/);
  expectReject(() => validateUploadEntry('actions/save.ts', 'File'), 'bad_extension', /\.ts/);
  expectReject(() => validateUploadEntry('foo.ts', 'File'), 'bad_extension');
});

test('rejects sibling TS-flavored extensions', () => {
  expectReject(() => validateUploadEntry('app.tsx', 'File'), 'bad_extension');
  expectReject(() => validateUploadEntry('types.d.ts', 'File'), 'bad_extension', /\.ts/);
  expectReject(() => validateUploadEntry('build.cts', 'File'), 'bad_extension');
  expectReject(() => validateUploadEntry('build.mts', 'File'), 'bad_extension');
});

test('rejects forbidden filenames', () => {
  expectReject(() => validateUploadEntry('data.sqlite', 'File'), 'forbidden_file', /data\.sqlite/);
  expectReject(
    () => validateUploadEntry('versions/v_x/current.json', 'File'),
    'forbidden_file',
    /current\.json/,
  );
  expectReject(
    () => validateUploadEntry('_registry.json', 'File'),
    'forbidden_file',
    /_registry\.json/,
  );
});

test('rejects path-traversal attempts', () => {
  expectReject(() => validateUploadEntry('../escape.js', 'File'), 'bad_path');
  expectReject(() => validateUploadEntry('/etc/passwd', 'File'), 'bad_path');
  expectReject(() => validateUploadEntry('a/../../b.js', 'File'), 'bad_path');
});

test('rejects symlinks and other entry types', () => {
  expectReject(() => validateUploadEntry('link.js', 'SymbolicLink'), 'bad_entry_type');
  expectReject(() => validateUploadEntry('link.js', 'Link'), 'bad_entry_type');
});

test('rejects oversize entries', () => {
  const SIX_MIB = 6 * 1024 * 1024;
  expectReject(() => validateUploadEntry('huge.js', 'File', SIX_MIB), 'entry_too_large');
});

test('case-insensitive extension allowlist', () => {
  validateUploadEntry('app.JS', 'File');
  validateUploadEntry('image.PNG', 'File');
  // …but uppercase doesn't sneak .TS past the block.
  expectReject(() => validateUploadEntry('x.TS', 'File'), 'bad_extension');
});

test('rejects extensionless files (handler files must have .js/.mjs)', () => {
  expectReject(() => validateUploadEntry('README', 'File'), 'bad_extension');
});

/*
 * End-to-end: drive the full `ingestUpload` pipeline with a real tarball.
 * Beyond regressing the policy at the integration boundary, this also
 * guards against the prior `uncaughtException` leak — node:test fails any
 * test whose process emits one, even if the test itself caught the
 * rejection.
 */

let workspace: string;
let sourceDir: string;
let appsDir: string;

beforeEach(async () => {
  workspace = path.join(os.tmpdir(), `centraid-upload-${crypto.randomBytes(6).toString('hex')}`);
  sourceDir = path.join(workspace, 'src');
  appsDir = path.join(workspace, 'apps');
  await fs.mkdir(sourceDir, { recursive: true });
  await fs.mkdir(appsDir, { recursive: true });
});

afterEach(async () => {
  await fs.rm(workspace, { recursive: true, force: true });
});

async function writeSource(relPath: string, contents = ''): Promise<void> {
  const abs = path.join(sourceDir, relPath);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, contents);
}

async function makeTarRequest(): Promise<IncomingMessage> {
  const entries = await fs.readdir(sourceDir);
  const stream = tar.create({ gzip: true, cwd: sourceDir, preservePaths: false }, entries);
  const chunks: Buffer[] = [];
  for await (const chunk of stream as unknown as AsyncIterable<Buffer | string>) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Readable.from(Buffer.concat(chunks)) as unknown as IncomingMessage;
}

test('e2e: ingestUpload accepts a clean .js-only archive', async () => {
  await writeSource('app.json', JSON.stringify({ name: 'Test', version: '0.1.0' }));
  await writeSource('index.html', '<!doctype html>');
  await writeSource('queries/list.js', 'export default async () => [];');
  await writeSource('migrations/0001_init.sql', 'CREATE TABLE t (id INTEGER);');

  const req = await makeTarRequest();
  const result = await ingestUpload(req, appsDir, 'testapp');

  assert.equal(result.declaredVersion, '0.1.0');
  assert.equal(result.files, 4);
  assert.ok(result.versionId.startsWith('v_'));
  assert.ok(await fs.stat(result.extractedDir).then((s) => s.isDirectory()));
});

test('e2e: ingestUpload rejects an archive containing .ts without leaking uncaughtException', async () => {
  await writeSource('app.json', JSON.stringify({ name: 'Test' }));
  await writeSource('queries/list.js', 'export default async () => [];');
  await writeSource('queries/list.ts', 'export default async () => [];');

  const req = await makeTarRequest();
  let caught: unknown;
  try {
    await ingestUpload(req, appsDir, 'testapp');
  } catch (e) {
    caught = e;
  }
  assert.ok(caught instanceof UploadError, `expected UploadError, got ${caught}`);
  assert.equal(caught.code, 'bad_extension');
  assert.match(caught.message, /\.ts/);
});

test('e2e: ingestUpload rejects an empty body with code "empty"', async () => {
  const req = Readable.from(Buffer.alloc(0)) as unknown as IncomingMessage;
  let caught: unknown;
  try {
    await ingestUpload(req, appsDir, 'testapp');
  } catch (e) {
    caught = e;
  }
  assert.ok(caught instanceof UploadError);
  assert.equal(caught.code, 'empty');
});
