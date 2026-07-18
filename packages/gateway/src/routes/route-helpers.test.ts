import { tempDirSync } from '@centraid/test-kit/temp-dir';
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  writeFileMap,
  readFileMap,
  sendJson,
  sendError,
  readBody,
  readJson,
  fileExists,
} from './route-helpers.js';

function tmp(): string {
  return tempDirSync('centraid-route-helpers-');
}

function mockReq(body: string | Buffer): IncomingMessage {
  const buf = typeof body === 'string' ? Buffer.from(body) : body;
  return Readable.from([buf]) as unknown as IncomingMessage;
}

function mockRes(): { res: ServerResponse; out: { status: number; body: string } } {
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

describe('writeFileMap / readFileMap', () => {
  it('round-trips a file map, creating parent dirs and skipping non-editable/dotfiles', async () => {
    const dir = tmp();
    await writeFileMap(dir, [
      { path: 'index.html', content: '<h1>hi</h1>' },
      { path: 'nested/app.js', content: 'export const x = 1;' },
      { path: 'blob.bin', content: 'not-editable' },
      { path: '.secret', content: 'dotfile' },
    ]);
    expect(readFileSync(join(dir, 'nested/app.js'), 'utf8')).toBe('export const x = 1;');
    const map = await readFileMap(dir);
    // Sorted, text-only, no dotfiles or non-editable extensions.
    expect(map.map((f) => f.path)).toEqual(['index.html', 'nested/app.js']);
  });

  it('refuses to write outside the app dir', async () => {
    const dir = tmp();
    await expect(writeFileMap(dir, [{ path: '../escape.ts', content: 'x' }])).rejects.toThrow(
      /outside the app/,
    );
  });

  it('reads a missing dir as an empty map', async () => {
    expect(await readFileMap(join(tmp(), 'does-not-exist'))).toEqual([]);
  });
});

describe('sendJson / sendError', () => {
  it('sendJson writes status + JSON body', () => {
    const { res, out } = mockRes();
    expect(sendJson(res, 201, { ok: true })).toBe(true);
    expect(out.status).toBe(201);
    expect(JSON.parse(out.body)).toEqual({ ok: true });
  });

  it('sendError wraps an Error as a 500 internal_error', () => {
    const { res, out } = mockRes();
    sendError(res, new Error('kaboom'));
    expect(out.status).toBe(500);
    expect(JSON.parse(out.body)).toEqual({ error: 'internal_error', message: 'kaboom' });
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
    await expect(readBody(mockReq('way too long'), 4)).rejects.toThrow(/too large/);
  });

  it('parses a JSON object body', async () => {
    expect(await readJson(mockReq('{"a":1}'))).toEqual({ a: 1 });
  });

  it('returns {} for an empty body', async () => {
    expect(await readJson(mockReq(''))).toEqual({});
  });

  it('rejects a non-object JSON body', async () => {
    await expect(readJson(mockReq('[1,2,3]'))).rejects.toThrow(/must be a JSON object/);
  });
});

describe('fileExists', () => {
  it('is true for a file and false for a missing path', async () => {
    const dir = tmp();
    await writeFileMap(dir, [{ path: 'a.txt', content: 'x' }]);
    expect(await fileExists(join(dir, 'a.txt'))).toBe(true);
    expect(await fileExists(join(dir, 'nope.txt'))).toBe(false);
  });
});
