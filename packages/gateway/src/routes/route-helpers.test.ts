import { readFileSync } from 'node:fs';
import http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
import path from 'node:path';
import { Readable } from 'node:stream';

import { tempDirSync } from '@centraid/test-kit/temp-dir';
import {
  DEVICE_IDENTITY_HEADER,
  DEVICE_PROOF_HEADER,
  TUNNEL_FORWARDED_HEADER,
} from '@centraid/tunnel';
import { afterEach, describe, expect, it, test } from 'vitest';

import {
  writeFileMap,
  readFileMap,
  sendJson,
  sendError,
  readBody,
  readJson,
  fileExists,
  isDirectHostRequest,
  isLoopbackRequest,
} from './route-helpers.js';

function tmp(): string {
  return tempDirSync('centraid-route-helpers-');
}

function mockReq(body: string | Buffer): IncomingMessage {
  const buf = typeof body === 'string' ? Buffer.from(body) : body;
  return Readable.from([buf]) as unknown as IncomingMessage;
}

function mockRes(): {
  res: ServerResponse;
  out: { status: number; body: string };
} {
  const out = { status: 0, body: '' };
  const res = {
    statusCode: 0,
    setHeader() {},
    end(text?: string) {
      out.status = res.statusCode;
      out.body = text ?? '';
    },
  } as unknown as ServerResponse;
  return { res, out };
}

const servers: http.Server[] = [];
describe('route-helpers', () => {
  afterEach(async () => {
    await Promise.all(
      servers
        .splice(0)
        .toReversed()
        .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
    );
  });

  async function endpoint(body: unknown): Promise<string> {
    const server = http.createServer((_req, res) => {
      sendJson(res, 200, body);
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  test('gateway-native JSON compresses large responses asynchronously (#456 C8)', async () => {
    const body = {
      rows: Array.from({ length: 500 }, (_, id) => ({
        id,
        title: `row-${id}`,
      })),
    };
    const response = await fetch(await endpoint(body), {
      headers: { 'accept-encoding': 'br' },
    });
    expect(response.headers.get('content-encoding')).toBe('br');
    expect(response.headers.get('vary')).toContain('Accept-Encoding');
    await expect(response.json()).resolves.toStrictEqual(body);
  });

  test('small JSON avoids compression overhead', async () => {
    const response = await fetch(await endpoint({ ok: true }), {
      headers: { 'accept-encoding': 'br' },
    });
    expect(response.headers.get('content-encoding')).toBeNull();
    await expect(response.json()).resolves.toStrictEqual({ ok: true });
  });

  test('encoding negotiation honors explicit q=0 exclusions', async () => {
    const body = {
      rows: Array.from({ length: 500 }, (_, id) => ({
        id,
        title: `row-${id}`,
      })),
    };
    const response = await fetch(await endpoint(body), {
      headers: { 'accept-encoding': 'br;q=0, gzip;q=0.7' },
    });
    expect(response.headers.get('content-encoding')).toBe('gzip');
    await expect(response.json()).resolves.toStrictEqual(body);
  });

  describe('writeFileMap / readFileMap', () => {
    it('round-trips a file map, creating parent dirs and skipping non-editable/dotfiles', async () => {
      const dir = tmp();
      await writeFileMap(dir, [
        { path: 'index.html', content: '<h1>hi</h1>' },
        { path: 'nested/app.js', content: 'export const x = 1;' },
        { path: 'blob.bin', content: 'not-editable' },
        { path: '.secret', content: 'dotfile' },
      ]);
      expect(readFileSync(path.join(dir, 'nested/app.js'), 'utf8')).toBe('export const x = 1;');
      const map = await readFileMap(dir);
      // Sorted, text-only, no dotfiles or non-editable extensions.
      expect(map.map((f) => f.path)).toStrictEqual(['index.html', 'nested/app.js']);
    });

    it('refuses to write outside the app dir', async () => {
      const dir = tmp();
      await expect(writeFileMap(dir, [{ path: '../escape.ts', content: 'x' }])).rejects.toThrow(
        /outside the app/u,
      );
    });

    it('reads a missing dir as an empty map', async () => {
      await expect(readFileMap(path.join(tmp(), 'does-not-exist'))).resolves.toStrictEqual([]);
    });
  });

  describe('sendJson / sendError', () => {
    it('sendJson writes status + JSON body', () => {
      const { res, out } = mockRes();
      expect(sendJson(res, 201, { ok: true })).toBe(true);
      expect(out.status).toBe(201);
      expect(JSON.parse(out.body)).toStrictEqual({ ok: true });
    });

    it('sendError wraps an Error as a 500 internal_error', () => {
      const { res, out } = mockRes();
      sendError(res, new Error('kaboom'));
      expect(out.status).toBe(500);
      expect(JSON.parse(out.body)).toStrictEqual({
        error: 'internal_error',
        message: 'kaboom',
      });
    });

    it('sendError stringifies a non-Error throw', () => {
      const { res, out } = mockRes();
      sendError(res, 'plain string');
      expect(JSON.parse(out.body).message).toBe('plain string');
    });
  });

  describe('readBody / readJson', () => {
    it('reads and concatenates the request body', async () => {
      expect((await readBody(mockReq('hello'))).toString('utf8')).toBe('hello');
    });

    it('throws when the body exceeds the cap', async () => {
      await expect(readBody(mockReq('way too long'), 4)).rejects.toThrow(/too large/u);
    });

    it('parses a JSON object body', async () => {
      await expect(readJson(mockReq('{"a":1}'))).resolves.toStrictEqual({
        a: 1,
      });
    });

    it('returns {} for an empty body', async () => {
      await expect(readJson(mockReq(''))).resolves.toStrictEqual({});
    });

    it('rejects a non-object JSON body', async () => {
      await expect(readJson(mockReq('[1,2,3]'))).rejects.toThrow(/must be a JSON object/u);
    });
  });

  describe(fileExists, () => {
    it('is true for a file and false for a missing path', async () => {
      const dir = tmp();
      await writeFileMap(dir, [{ path: 'a.txt', content: 'x' }]);
      await expect(fileExists(path.join(dir, 'a.txt'))).resolves.toBe(true);
      await expect(fileExists(path.join(dir, 'nope.txt'))).resolves.toBe(false);
    });
  });

  /*
   * `isDirectHostRequest` — the real host-only capability gate (issue #568
   * items A/B). The founding tests stub `canMintFoundingTicket: () => true`, so
   * without this nothing exercises the predicate the product actually installs.
   *
   * The organising rule: LOOPBACK IS NOT AN IDENTITY. Every forwarder in the
   * product — the daemon's iroh endpoint, the Rust byte relay, and the desktop
   * phone tunnel — delivers a REMOTE peer to 127.0.0.1, and each marks the hop
   * on the way through. A host-only capability needs a loopback socket AND the
   * absence of every marking.
   */
  function fakeRequest(
    remoteAddress: string | undefined,
    headers: Record<string, string> = {},
  ): IncomingMessage {
    return { socket: { remoteAddress }, headers } as unknown as IncomingMessage;
  }

  describe(isDirectHostRequest, () => {
    it('accepts a bare loopback peer on every loopback address form', () => {
      for (const address of ['127.0.0.1', '127.0.0.53', '::1', '::ffff:127.0.0.1']) {
        expect(isDirectHostRequest(fakeRequest(address)), address).toBe(true);
      }
    });

    it('refuses a non-loopback peer', () => {
      expect(isDirectHostRequest(fakeRequest('10.0.0.4'))).toBe(false);
      expect(isDirectHostRequest(fakeRequest(undefined))).toBe(false);
    });

    it('refuses a loopback peer carrying ANY forwarder marking', () => {
      // The iroh forwarder stamps the proved identity + proof…
      expect(
        isDirectHostRequest(fakeRequest('127.0.0.1', { [DEVICE_IDENTITY_HEADER]: 'remote-peer' })),
      ).toBe(false);
      expect(
        isDirectHostRequest(fakeRequest('127.0.0.1', { [DEVICE_PROOF_HEADER]: 'per-boot-proof' })),
      ).toBe(false);
      // …and the desktop phone tunnel, which has no device key to stamp, marks
      // the hop instead. This is the header that closes item A: a QR-paired
      // phone reaches 127.0.0.1 carrying the host's admin bearer.
      expect(
        isDirectHostRequest(fakeRequest('127.0.0.1', { [TUNNEL_FORWARDED_HEADER]: '1' })),
      ).toBe(false);
    });

    it('is strictly stronger than the bare-loopback gate it replaced', () => {
      // The pre-#566 gate that `buildGateway` still fell back to for the
      // embedded desktop (item B) said yes to exactly this request.
      const forwarded = fakeRequest('127.0.0.1', {
        [TUNNEL_FORWARDED_HEADER]: '1',
      });
      expect(isLoopbackRequest(forwarded)).toBe(true);
      expect(isDirectHostRequest(forwarded)).toBe(false);
    });
  });
});
