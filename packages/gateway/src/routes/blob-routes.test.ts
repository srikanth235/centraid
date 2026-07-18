import { tempDir } from '@centraid/test-kit/temp-dir';
// The blob routes (issue #296) over a real vault plane: stream bytes in,
// claim them through a command, and serve them back with ETag/Range — the
// full staged-upload loop an app performs.

import { afterEach, expect, test } from 'vitest';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import crypto from 'node:crypto';
import { deflateSync } from 'node:zlib';
import jpegJs from 'jpeg-js';
import { createImagePreviewCodec } from '../preview/codec.js';
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

/** A structurally valid one-page PDF with a real Flate-compressed content stream. */
function compressedPdf(text: string): Buffer {
  const stream = deflateSync(Buffer.from(`BT /F1 12 Tf 72 720 Td (${text}) Tj ET`));
  const objects = [
    Buffer.from('<< /Type /Catalog /Pages 2 0 R >>'),
    Buffer.from('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'),
    Buffer.from(
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ' +
        '/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    ),
    Buffer.concat([
      Buffer.from(`<< /Length ${stream.length} /Filter /FlateDecode >>\nstream\n`),
      stream,
      Buffer.from('\nendstream'),
    ]),
    Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'),
  ];
  const chunks = [Buffer.from('%PDF-1.7\n%\xE2\xE3\xCF\xD3\n', 'latin1')];
  const offsets = [0];
  let size = chunks[0]!.length;
  for (const [index, object] of objects.entries()) {
    offsets.push(size);
    const bytes = Buffer.concat([
      Buffer.from(`${index + 1} 0 obj\n`),
      object,
      Buffer.from('\nendobj\n'),
    ]);
    chunks.push(bytes);
    size += bytes.length;
  }
  const xrefAt = size;
  const xref = offsets
    .map((offset, index) =>
      index === 0 ? '0000000000 65535 f \n' : `${String(offset).padStart(10, '0')} 00000 n \n`,
    )
    .join('');
  chunks.push(
    Buffer.from(
      `xref\n0 ${offsets.length}\n${xref}trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\n` +
        `startxref\n${xrefAt}\n%%EOF\n`,
    ),
  );
  return Buffer.concat(chunks);
}

async function fixture(
  previewCodec?: ReturnType<typeof createImagePreviewCodec>,
): Promise<{ base: string; plane: VaultPlane }> {
  const dir = await tempDir(`blob-routes-${crypto.randomUUID()}-`);
  cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
  const plane = openVaultPlane({
    dir,
    logger: silentLogger,
    ownerName: 'Priya',
    ...(previewCodec ? { previewCodec } : {}),
  });
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

function makeJpeg(width: number, height: number): Buffer {
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      data[offset] = x * 10;
      data[offset + 1] = y * 20;
      data[offset + 2] = x + y;
      data[offset + 3] = 255;
    }
  }
  return Buffer.from(jpegJs.encode({ data, width, height }, 90).data);
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

test('bare raw JPEG ingress publishes thumb, preview and inline phash/thumbhash backstops', async () => {
  const codec = createImagePreviewCodec();
  const { base, plane } = await fixture(codec);
  const jpeg = makeJpeg(18, 8);
  const expectedPhash = codec.perceptualHash(jpeg, 'image/jpeg');
  const expectedThumbhash = codec.thumbhash(jpeg, 'image/jpeg');

  const response = await fetch(`${base}?filename=curl.jpg`, {
    method: 'POST',
    headers: { 'content-type': 'image/jpeg' },
    body: new Uint8Array(jpeg),
  });
  expect(response.status).toBe(200);
  const staged = (await response.json()) as { sha256: string };
  const outcome = plane.gateway.invoke(plane.ownerCredential, {
    command: 'media.add_asset',
    input: { staged_sha: staged.sha256, kind: 'photo' },
    purpose: 'dpv:ServiceProvision',
  });
  expect(outcome.status).toBe('executed');
  const output = (outcome as { output: { asset_id: string; content_id: string } }).output;
  const derivatives = plane.db.vault
    .prepare(
      `SELECT variant, sha256, text_content FROM core_content_derivative
        WHERE content_id = ? ORDER BY variant`,
    )
    .all(output.content_id) as {
    variant: string;
    sha256: string | null;
    text_content: string | null;
  }[];
  expect(derivatives).toEqual([
    { variant: 'phash', sha256: null, text_content: expectedPhash },
    expect.objectContaining({ variant: 'preview', text_content: null }),
    expect.objectContaining({ variant: 'thumb', text_content: null }),
    { variant: 'thumbhash', sha256: null, text_content: expectedThumbhash },
  ]);
  expect(derivatives[1]?.sha256).toMatch(/^[0-9a-f]{64}$/);
  expect(derivatives[2]?.sha256).toMatch(/^[0-9a-f]{64}$/);
  expect(
    plane.db.vault
      .prepare('SELECT phash FROM media_asset_phash WHERE asset_id = ?')
      .get(output.asset_id),
  ).toEqual({ phash: expectedPhash });
});

test('raw curl-style upload makes a Flate-compressed PDF searchable through cheap text', async () => {
  const { base, plane } = await fixture();
  const pdf = compressedPdf('Gateway curl path finds the midnight narwhal renewal clause');
  const response = await fetch(`${base}?filename=renewal.pdf`, {
    method: 'POST',
    headers: { 'content-type': 'application/pdf' },
    body: new Uint8Array(pdf),
  });
  expect(response.status).toBe(200);
  const staged = (await response.json()) as { sha256: string; mediaType: string };
  expect(staged.mediaType).toBe('application/pdf');

  const outcome = plane.gateway.invoke(plane.ownerCredential, {
    command: 'core.add_document',
    input: { staged_sha: staged.sha256, title: 'renewal.pdf' },
    purpose: 'dpv:ServiceProvision',
  });
  expect(outcome.status).toBe('executed');
  const ids = (outcome as { output: { content_id: string; document_id: string } }).output;
  const derivative = plane.db.vault
    .prepare(
      `SELECT media_type, byte_size, text_content FROM core_content_derivative
        WHERE content_id = ? AND variant = 'text'`,
    )
    .get(ids.content_id) as { media_type: string; byte_size: number; text_content: string };
  expect(derivative.media_type).toBe('text/plain');
  expect(derivative.byte_size).toBe(Buffer.byteLength(derivative.text_content));
  expect(derivative.text_content).toContain('midnight narwhal renewal clause');
  expect(
    plane.gateway
      .search(plane.ownerCredential, {
        entity: 'core.document',
        query: 'narwhal',
        purpose: 'dpv:ServiceProvision',
      })
      .rows.map((row) => row.document_id),
  ).toContain(ids.document_id);
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
  const thumbBytes = PNG_BYTES;
  const stagedThumb = await fetch(
    `${base}?variant=thumb&variant_of=${staged.sha256}&media_type=image/png`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: new Uint8Array(thumbBytes),
    },
  );
  expect(stagedThumb.status).toBe(200);
  const outcome = plane.gateway.invoke(plane.ownerCredential, {
    command: 'core.add_document',
    input: { staged_sha: staged.sha256, title: 'p.png' },
    purpose: 'dpv:ServiceProvision',
  });
  const contentId = (outcome as { output: { content_id: string } }).output.content_id;
  const thumb = await fetch(`${base}/${contentId}?variant=thumb`);
  expect(thumb.status).toBe(200);
  expect(thumb.headers.get('content-type')).toBe('image/png');
  expect(Buffer.from(await thumb.arrayBuffer()).equals(thumbBytes)).toBe(true);
  // A variant nobody produced is a clean 404.
  const missing = await fetch(`${base}/${contentId}?variant=preview`);
  expect(missing.status).toBe(404);
});

test('typed contribution door accepts every derivative class and rejects malformed input', async () => {
  const { base, plane } = await fixture();
  const original = (await (
    await fetch(base, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ base64: PNG_BYTES.toString('base64'), filename: 'typed.png' }),
    })
  ).json()) as { sha256: string };
  const post = (variant: string, bytes: Buffer, mediaType: string) =>
    fetch(
      `${base}?variant=${variant}&variant_of=${original.sha256}&media_type=${encodeURIComponent(mediaType)}`,
      {
        method: 'POST',
        headers: { 'content-type': mediaType },
        body: new Uint8Array(bytes),
      },
    );

  for (const variant of ['thumb', 'preview', 'poster']) {
    expect((await post(variant, PNG_BYTES, 'image/png')).status, variant).toBe(200);
  }
  expect(
    (await post('text', Buffer.from('PDF.js found a quasar clause'), 'text/plain')).status,
  ).toBe(200);
  expect((await post('transcript', Buffer.from('spoken cobalt detail'), 'text/plain')).status).toBe(
    200,
  );
  expect(
    (
      await post(
        'embedding',
        Buffer.from('{"model":"edge-v1","vector":[1,0.25]}'),
        'application/vnd.centraid.embedding+json',
      )
    ).status,
  ).toBe(200);
  expect(
    (await post('phash', Buffer.from('0123456789abcdef'), 'text/x-perceptual-hash')).status,
  ).toBe(200);

  const outcome = plane.gateway.invoke(plane.ownerCredential, {
    command: 'core.add_document',
    input: { staged_sha: original.sha256, title: 'Typed contributions' },
    purpose: 'dpv:ServiceProvision',
  });
  expect(outcome.status).toBe('executed');
  const contentId = (outcome as { output: { content_id: string } }).output.content_id;
  const variants = plane.db.vault
    .prepare('SELECT variant FROM core_content_derivative WHERE content_id = ? ORDER BY variant')
    .all(contentId) as { variant: string }[];
  expect(variants.map((row) => row.variant)).toEqual([
    'embedding',
    'phash',
    'poster',
    'preview',
    'text',
    'thumb',
    'transcript',
  ]);
  expect((await fetch(`${base}/${contentId}?variant=poster`)).status).toBe(200);
  expect(
    plane.gateway
      .search(plane.ownerCredential, {
        entity: 'core.document',
        query: 'quasar',
        purpose: 'dpv:ServiceProvision',
      })
      .rows.map((row) => row.document_id),
  ).toContain((outcome as { output: { document_id: string } }).output.document_id);

  expect((await post('poster', Buffer.from('not an image'), 'image/jpeg')).status).toBe(400);
  expect((await post('unknown', Buffer.from('x'), 'text/plain')).status).toBe(400);
  expect(
    (
      await fetch(`${base}?variant=poster`, {
        method: 'POST',
        headers: { 'content-type': 'image/png' },
        body: new Uint8Array(PNG_BYTES),
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await fetch(`${base}?variant_of=${original.sha256}`, {
        method: 'POST',
        headers: { 'content-type': 'image/png' },
        body: new Uint8Array(PNG_BYTES),
      })
    ).status,
  ).toBe(400);
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
