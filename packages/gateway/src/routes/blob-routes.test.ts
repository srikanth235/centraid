// The blob routes (issue #296) over a real vault plane: stream bytes in,
// claim them through a command, and serve them back with ETag/Range — the
// full staged-upload loop an app performs.

import { afterEach, expect, test } from 'vitest';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { openVaultPlane, type VaultPlane } from '../serve/vault-plane.js';
import { makeBlobRouteHandler } from './blob-routes.js';

const silentLogger = { info: () => undefined, warn: () => undefined, error: () => undefined };

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);

async function fixture(): Promise<{ base: string; plane: VaultPlane }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `blob-routes-${crypto.randomUUID()}-`));
  cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
  const plane = openVaultPlane({ dir, logger: silentLogger, ownerName: 'Priya' });
  cleanups.push(() => plane.stop());
  const handler = makeBlobRouteHandler({ current: () => plane });
  const server = http.createServer((req, res) => {
    void handler(req, res).then((handled) => {
      if (!handled) {
        res.statusCode = 404;
        res.end();
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address() as { port: number };
  return { base: `http://127.0.0.1:${address.port}/centraid/_vault/blobs`, plane };
}

test('raw upload → claim via core.add_document → serve with ETag/Range/304', async () => {
  const { base, plane } = await fixture();

  // The streaming door: raw bytes, metadata in the query string.
  const staged = (await (
    await fetch(`${base}?filename=pixel.png`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: new Uint8Array(PNG_BYTES),
    })
  ).json()) as { sha256: string; mediaType: string; byteSize: number };
  expect(staged.mediaType).toBe('image/png'); // sniffed from magic bytes
  expect(staged.byteSize).toBe(PNG_BYTES.length);

  // Claim: the command is the write; the journal records a sha, not bytes.
  const outcome = plane.gateway.invoke(plane.ownerCredential, {
    command: 'core.add_document',
    input: { staged_sha: staged.sha256, title: 'pixel.png' },
    purpose: 'dpv:ServiceProvision',
  });
  expect(outcome.status).toBe('executed');
  const contentId = (outcome as { output: { content_id: string } }).output.content_id;

  // Serve: whole body, content-addressed caching headers.
  const whole = await fetch(`${base}/${contentId}`);
  expect(whole.status).toBe(200);
  expect(whole.headers.get('content-type')).toBe('image/png');
  expect(whole.headers.get('etag')).toBe(`"${staged.sha256}"`);
  expect(whole.headers.get('cache-control')).toContain('immutable');
  expect(whole.headers.get('accept-ranges')).toBe('bytes');
  expect(Buffer.from(await whole.arrayBuffer()).equals(PNG_BYTES)).toBe(true);

  // Conditional revalidation: same ETag → 304, no body.
  const cached = await fetch(`${base}/${contentId}`, {
    headers: { 'if-none-match': `"${staged.sha256}"` },
  });
  expect(cached.status).toBe(304);

  // Range: the video-scrubbing contract.
  const range = await fetch(`${base}/${contentId}`, { headers: { range: 'bytes=8-15' } });
  expect(range.status).toBe(206);
  expect(range.headers.get('content-range')).toBe(`bytes 8-15/${PNG_BYTES.length}`);
  expect(Buffer.from(await range.arrayBuffer()).equals(PNG_BYTES.subarray(8, 16))).toBe(true);

  // Unsatisfiable range is a 416, not a 200-with-everything.
  const bad = await fetch(`${base}/${contentId}`, { headers: { range: 'bytes=9999-' } });
  expect(bad.status).toBe(416);

  // Download disposition on demand.
  const dl = await fetch(`${base}/${contentId}?download=1`);
  expect(dl.headers.get('content-disposition')).toBe('attachment; filename="pixel.png"');
});

test('json (base64) upload door and thumb variants serve under ?variant=', async () => {
  const { base, plane } = await fixture();
  const staged = (await (
    await fetch(base, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ base64: PNG_BYTES.toString('base64'), filename: 'p.png' }),
    })
  ).json()) as { sha256: string };
  // A client-produced thumb rides beside its parent.
  const thumbBytes = Buffer.from('thumb-bytes');
  await fetch(`${base}?variant=thumb&variant_of=${staged.sha256}&media_type=image/jpeg`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body: new Uint8Array(thumbBytes),
  });
  const outcome = plane.gateway.invoke(plane.ownerCredential, {
    command: 'core.add_document',
    input: { staged_sha: staged.sha256, title: 'p.png' },
    purpose: 'dpv:ServiceProvision',
  });
  const contentId = (outcome as { output: { content_id: string } }).output.content_id;
  const thumb = await fetch(`${base}/${contentId}?variant=thumb`);
  expect(thumb.status).toBe(200);
  expect(thumb.headers.get('content-type')).toBe('image/jpeg');
  expect(Buffer.from(await thumb.arrayBuffer()).equals(thumbBytes)).toBe(true);
  // A variant nobody produced is a clean 404.
  const missing = await fetch(`${base}/${contentId}?variant=preview`);
  expect(missing.status).toBe(404);
});

test('unclaimed bytes never serve: 404 for unknown ids and unreferenced content', async () => {
  const { base } = await fixture();
  const nope = await fetch(`${base}/does-not-exist`);
  expect(nope.status).toBe(404);
  expect((await nope.json()) as Record<string, unknown>).toEqual({ error: 'not-found' });
  // Empty uploads are refused.
  const empty = await fetch(base, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
  });
  expect(empty.status).toBe(400);
});
