import { test, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { promises as fs } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import path from 'node:path';
import os from 'node:os';
import { Parser } from 'tar';
import { publishApp } from './publish.ts';

/**
 * Regression for the empty-tar bug: `tar.create({cwd}, ['.'])` feeds the
 * cwd itself to the filter as `"."`. An earlier filter rejected anything
 * starting with `.`, including the cwd marker — so tar never recursed
 * and the body was 30 bytes of gzip magic with zero entries. The plugin
 * then 400'd with TAR_BAD_ARCHIVE.
 */

let tmpRoot: string;
let appDir: string;
let captured: { url: string; body: Buffer; headers: Headers } | undefined;
let originalFetch: typeof fetch;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-publish-'));
  appDir = path.join(tmpRoot, 'sample');
  await fs.mkdir(appDir);
  await fs.writeFile(
    path.join(appDir, 'app.json'),
    JSON.stringify(
      {
        manifestVersion: 1,
        id: 'sample',
        name: 'Sample',
        version: '0.2.0',
        actions: [],
        queries: [
          {
            name: 'ping',
            input: { type: 'object', properties: {}, additionalProperties: false },
          },
        ],
      },
      null,
      2,
    ),
  );
  await fs.writeFile(path.join(appDir, 'index.html'), '<!doctype html><h1>hi</h1>');
  await fs.mkdir(path.join(appDir, 'queries'));
  await fs.writeFile(path.join(appDir, 'queries', 'ping.js'), 'export default ()=>({ok:true})');
  // Things that should be filtered out:
  await fs.writeFile(path.join(appDir, '.env'), 'SECRET=nope\n');
  await fs.mkdir(path.join(appDir, 'node_modules', 'junk'), { recursive: true });
  await fs.writeFile(path.join(appDir, 'node_modules', 'junk', 'a.js'), '// junk');
  await fs.mkdir(path.join(appDir, '.git'));
  await fs.writeFile(path.join(appDir, '.git', 'HEAD'), 'ref: refs/heads/main');

  captured = undefined;
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const bodyBytes = init?.body instanceof Uint8Array ? Buffer.from(init.body) : Buffer.alloc(0);
    captured = { url, body: bodyBytes, headers: new Headers(init?.headers) };
    return new Response(
      JSON.stringify({
        id: 'sample',
        versionId: 'v_test',
        sha256: 'x'.repeat(64),
        files: 0,
        bytes: bodyBytes.byteLength,
        activated: true,
        migrationsApplied: [],
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  }) as typeof fetch;
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

async function entryNamesFromGzip(body: Buffer): Promise<string[]> {
  const raw = gunzipSync(body);
  const names: string[] = [];
  await new Promise<void>((resolve, reject) => {
    const parser = new Parser();
    parser.on('entry', (e) => {
      names.push(e.path);
      e.resume();
    });
    parser.on('end', () => resolve());
    parser.on('error', reject);
    parser.end(raw);
  });
  return names;
}

test('publishApp ships a non-empty gzip tar (regression: cwd marker not filtered out)', async () => {
  await publishApp(
    appDir,
    'sample',
    { appsDir: tmpRoot, gatewayUrl: 'http://127.0.0.1:1', gatewayToken: '' },
    { skipBuild: true },
  );

  assert.ok(captured, 'fetch was not called');
  assert.equal(captured!.headers.get('content-type'), 'application/gzip');
  assert.ok(captured!.body.byteLength > 100, `body too small: ${captured!.body.byteLength} bytes`);
  assert.equal(captured!.body[0], 0x1f);
  assert.equal(captured!.body[1], 0x8b);

  const names = (await entryNamesFromGzip(captured!.body)).map((p) => p.replace(/^\.\//, ''));
  // App files are present.
  assert.ok(names.includes('app.json'), `app.json missing: ${names.join(', ')}`);
  assert.ok(names.includes('index.html'));
  assert.ok(names.includes('queries/ping.js'));
  // Excluded entries are absent.
  assert.ok(!names.some((n) => n.startsWith('node_modules')), 'node_modules leaked');
  assert.ok(!names.some((n) => n.startsWith('.git')), '.git leaked');
  assert.ok(!names.includes('.env'), '.env leaked');
});
