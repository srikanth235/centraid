import crypto from 'node:crypto';
import { once } from 'node:events';
import { promises as fs } from 'node:fs';
import http, { type Server } from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { tempDir } from '@centraid/test-kit/temp-dir';
import { createBlobHandoffUrl } from '../serve/data-plane-handoff.js';
import {
  startTypeScriptBytePlane,
  type TypeScriptBytePlaneHandle,
} from './byte-plane-reference.js';

const externalBaseUrl = process.env.CENTRAID_BYTE_PLANE_BASE_URL;
const implementation = externalBaseUrl
  ? 'external'
  : (process.env.CENTRAID_BYTE_PLANE_IMPLEMENTATION ?? 'rust');
const enabled =
  process.env.CENTRAID_RUN_BYTE_PLANE_CONTRACT === '1' ||
  process.env.CENTRAID_RUN_RUST_CONTRACT === '1' ||
  externalBaseUrl !== undefined;
const secret = process.env.CENTRAID_BYTE_PLANE_SECRET ?? '0123456789abcdef0123456789abcdef';
let child: ChildProcess | undefined;
let reference: TypeScriptBytePlaneHandle | undefined;
let root = '';
let baseUrl = '';
let blobFile = '';
let provider: Server | undefined;
let providerUrl = '';
let pumped = Buffer.alloc(0);

async function unusedPort(): Promise<number> {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  server.close();
  await once(server, 'close');
  return port;
}

async function waitForHealth(): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      if ((await fetch(`${baseUrl}/v1/health`)).ok) return;
    } catch {
      // Process is still binding.
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('byte-plane test daemon did not become healthy');
}

describe.skipIf(!enabled)(
  `byte plane over HTTP implementation contract (${implementation})`,
  () => {
    beforeAll(async () => {
      if (externalBaseUrl) {
        const externalRoot = process.env.CENTRAID_BYTE_PLANE_ROOT;
        if (!externalRoot) {
          throw new Error('CENTRAID_BYTE_PLANE_ROOT is required with CENTRAID_BYTE_PLANE_BASE_URL');
        }
        root = path.resolve(externalRoot);
        baseUrl = externalBaseUrl.replace(/\/+$/, '');
      } else {
        // tempDir cleans owned roots after the file; external roots stay.
        root = await tempDir('centraid-byte-plane-contract-');
      }
      blobFile = path.join(root, 'vault', 'blobs', 'fixture.bin');
      await fs.mkdir(path.dirname(blobFile), { recursive: true });
      await fs.writeFile(blobFile, Buffer.from('0123456789abcdefghijklmnopqrstuvwxyz'));
      provider = http.createServer((req, res) => {
        void (async () => {
          const chunks: Buffer[] = [];
          for await (const chunk of req) chunks.push(Buffer.from(chunk));
          pumped = Buffer.concat(chunks);
          res.writeHead(201, { etag: '"provider-etag"' });
          res.end();
        })().catch((error: unknown) => {
          res.destroy(error instanceof Error ? error : new Error(String(error)));
        });
      });
      provider.listen(0, '127.0.0.1');
      await once(provider, 'listening');
      const providerAddress = provider.address();
      if (!providerAddress || typeof providerAddress === 'string') {
        throw new Error('provider contract server did not bind');
      }
      providerUrl = `http://127.0.0.1:${providerAddress.port}/upload`;
      if (!externalBaseUrl && implementation === 'typescript') {
        reference = await startTypeScriptBytePlane({ root, secret });
        baseUrl = reference.baseUrl;
      } else if (!externalBaseUrl) {
        const binary = process.env.CENTRAID_BYTE_PLANE_BIN;
        if (!binary) throw new Error('CENTRAID_BYTE_PLANE_BIN is required');
        const port = await unusedPort();
        baseUrl = `http://127.0.0.1:${port}`;
        child = spawn(binary, [
          'serve-http',
          '--listen',
          `127.0.0.1:${port}`,
          '--root',
          root,
          '--ticket-secret',
          secret,
        ]);
        child.stderr?.on('data', (chunk) => process.stderr.write(chunk));
      }
      await waitForHealth();
    }, 30_000);

    afterAll(async () => {
      child?.kill('SIGTERM');
      if (child)
        await Promise.race([
          once(child, 'exit'),
          new Promise((resolve) => setTimeout(resolve, 1_000)),
        ]);
      await reference?.close();
      if (provider) {
        provider.close();
        await once(provider, 'close');
      }
    });

    test('streams SHA-256 with a language-independent JSON contract', async () => {
      const bytes = crypto.randomBytes(512 * 1024);
      expect(
        (
          await fetch(`${baseUrl}/v1/hash`, {
            method: 'POST',
            body: bytes,
          })
        ).status,
      ).toBe(403);
      const response = await fetch(`${baseUrl}/v1/hash`, {
        method: 'POST',
        headers: { 'x-centraid-data-plane-secret': secret },
        body: bytes,
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
        byteSize: bytes.length,
      });
    });

    test('serves a signed one-use bounded Range ticket', async () => {
      const url = createBlobHandoffUrl(
        { baseUrl, secret, rootDir: root },
        {
          file: blobFile,
          mediaType: 'application/octet-stream',
          disposition: 'inline; filename="fixture.bin"',
          etag: '"fixture"',
        },
      )!;
      const response = await fetch(url, { headers: { Range: 'bytes=4-11' } });
      expect(response.status).toBe(206);
      expect(response.headers.get('content-range')).toBe('bytes 4-11/36');
      expect(await response.text()).toBe('456789ab');
      expect((await fetch(url)).status).toBe(401);

      const zeroSuffixUrl = createBlobHandoffUrl(
        { baseUrl, secret, rootDir: root },
        {
          file: blobFile,
          mediaType: 'application/octet-stream',
          disposition: 'inline; filename="fixture.bin"',
          etag: '"fixture"',
        },
      )!;
      expect((await fetch(zeroSuffixUrl, { headers: { Range: 'bytes=-0' } })).status).toBe(416);
    });

    test('compresses and previews only with the control secret', async () => {
      const compressInput = Buffer.alloc(128 * 1024, 65);
      expect(
        (
          await fetch(`${baseUrl}/v1/compress`, {
            method: 'POST',
            body: compressInput,
          })
        ).status,
      ).toBe(403);
      const compressed = await fetch(`${baseUrl}/v1/compress`, {
        method: 'POST',
        headers: { 'x-centraid-data-plane-secret': secret },
        body: compressInput,
      });
      expect(compressed.status).toBe(200);
      expect(compressed.headers.get('content-type')).toBe('application/zstd');
      expect(Buffer.from(await compressed.arrayBuffer()).subarray(0, 4)).toEqual(
        Buffer.from([0x28, 0xb5, 0x2f, 0xfd]),
      );

      const png = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
        'base64',
      );
      expect(
        (
          await fetch(`${baseUrl}/v1/preview?edge=32`, {
            method: 'POST',
            body: png,
          })
        ).status,
      ).toBe(403);
      const preview = await fetch(`${baseUrl}/v1/preview?edge=32`, {
        method: 'POST',
        headers: { 'x-centraid-data-plane-secret': secret },
        body: png,
      });
      expect(preview.status).toBe(200);
      expect(preview.headers.get('content-type')).toBe('image/jpeg');
      const jpeg = Buffer.from(await preview.arrayBuffer());
      expect(jpeg.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
      expect(jpeg.subarray(-2)).toEqual(Buffer.from([0xff, 0xd9]));
    });

    test('streams an authorized file window to the provider pump', async () => {
      const request = {
        relativePath: 'vault/blobs/fixture.bin',
        destinationUrl: providerUrl,
        offset: 4,
        length: 8,
        headers: { 'x-provider-contract': 'issue-456' },
      };
      expect(
        (
          await fetch(`${baseUrl}/v1/pump`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(request),
          })
        ).status,
      ).toBe(403);
      const response = await fetch(`${baseUrl}/v1/pump`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-centraid-data-plane-secret': secret,
        },
        body: JSON.stringify(request),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        byteSize: 8,
        providerStatus: 201,
        etag: '"provider-etag"',
      });
      expect(pumped.toString()).toBe('456789ab');
    });
  },
);
