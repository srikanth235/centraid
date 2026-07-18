/*
 * Golden-frame conformance for the tunnel wire protocol (issue #263 / #419).
 *
 * The framing — u32 big-endian length prefix + UTF-8 JSON header frame — is
 * implemented five times (Node here, Swift + Kotlin in
 * apps/mobile/modules/centraid-tunnel, Rust/WASM in apps/web/iroh-wasm, and
 * the Node desktop/gateway twins). They must not drift. This test is the
 * SOURCE OF TRUTH for `fixtures/wire-golden.json`: the same fixture is read
 * by the Swift XCTest and Kotlin JUnit conformance tests so every language
 * asserts against identical bytes.
 *
 * What is byte-exact across ALL languages: the framing of a fixed JSON byte
 * string (length prefix mechanics), the ALPN byte strings, and the caps.
 * JSON *object* encoding is not byte-comparable across serializers (key order
 * differs between JSON.stringify / JSONSerialization / org.json / serde_json),
 * so object encoding is checked by round-trip (encode → decode → compare
 * fields), while the on-wire framing is pinned to the fixture's canonical
 * `json` string. See fixtures/wire-golden.json `_readme`.
 *
 * Regenerate after an intentional vector change: `UPDATE_GOLDEN=1 vitest run
 * wire-conformance`. The fixture is committed and must stay byte-exact.
 */

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { GW_PAIR_ALPN } from './gateway-endpoint.js';
import {
  alpnBytes,
  encodeHeaderFrame,
  MAX_HEADER_FRAME_BYTES,
  MAX_REQUEST_BODY_BYTES,
  PAIR_ALPN,
  READ_CHUNK_BYTES,
  readHeaderFrame,
  TUNNEL_ALPN,
} from './protocol.js';

const FIXTURE_PATH = fileURLToPath(new URL('../fixtures/wire-golden.json', import.meta.url));

/** The hop-by-hop set every implementation strips (RFC 9110 §7.6.1). */
const HOP_BY_HOP = [
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
];

/**
 * Named logical vectors. The object is what an implementation builds in
 * memory; `encodeHeaderFrame` turns it into the canonical on-wire bytes. The
 * Node encoder (JSON.stringify, insertion order) defines the canonical form.
 */
const VECTORS: Array<{ name: string; note: string; value: unknown }> = [
  {
    name: 'tunnelRequestHeader',
    note: 'HTTP request header frame: {method, target, headers}.',
    value: {
      method: 'GET',
      target: '/centraid/notes/?limit=20',
      headers: { accept: 'text/html', 'x-centraid-vault': 'personal' },
    },
  },
  {
    name: 'tunnelResponseHeader',
    note: 'HTTP response header frame: {status, headers}.',
    value: {
      status: 200,
      headers: { 'content-type': 'application/json', 'content-length': '17' },
    },
  },
  {
    name: 'tunnelRequestEmptyHeaders',
    note: 'Edge: empty headers object still frames + round-trips.',
    value: { method: 'DELETE', target: '/centraid/tasks/42', headers: {} },
  },
  {
    name: 'tunnelResponseMultiValueHeader',
    note: 'Edge: a repeated header is carried as a JSON array (set-cookie).',
    value: {
      status: 200,
      headers: { 'set-cookie': ['a=1; HttpOnly', 'b=2; HttpOnly'], vary: 'accept' },
    },
  },
  {
    name: 'tunnelRequestUnicode',
    note: 'Edge: non-ASCII in JSON — jsonByteLength is UTF-8 bytes, not chars.',
    value: {
      method: 'POST',
      target: '/centraid/notes/?q=r%C3%A9sum%C3%A9',
      headers: { 'x-note-title': 'résumé 🔒', 'content-type': 'application/json' },
    },
  },
  {
    name: 'pairRequest',
    note: 'centraid/pair/1 phone→desktop: {code, deviceName, platform}.',
    value: { code: '482913', deviceName: "Sri's iPhone", platform: 'ios' },
  },
  {
    name: 'pairResponseOk',
    note: 'centraid/pair/1 desktop→phone success.',
    value: { ok: true, deviceId: 'dev_7f3a', desktopName: 'studio-mini' },
  },
  {
    name: 'pairResponseError',
    note: 'centraid/pair/1 desktop→phone failure.',
    value: { ok: false, error: 'invalid_code' },
  },
  {
    name: 'gatewayPairRequest',
    note: 'centraid/gw-pair/1 ticket redemption request (all fields).',
    value: {
      ticketId: 'tkt_1a2b',
      secret: 's3cr3t-one-time',
      deviceName: 'Pixel 9',
      platform: 'android',
      rememberDevice: true,
      trust: 'full',
    },
  },
  {
    name: 'gatewayPairResponse',
    note: 'centraid/gw-pair/1 redemption response (all fields).',
    value: {
      ok: true,
      gatewayId: 'gw_9c8d',
      gatewayName: 'home',
      vaultId: 'vlt_42',
      vaultName: 'personal',
      version: '0.1.0',
      schemaEpoch: 7,
    },
  },
];

interface GoldenVector {
  name: string;
  note: string;
  json: string;
  jsonByteLength: number;
  frameBase64: string;
}

interface GoldenFixture {
  _readme: string[];
  version: number;
  alpns: Record<string, string>;
  caps: Record<string, number>;
  hopByHopHeaders: string[];
  vectors: GoldenVector[];
}

/** u32 BE length prefix + UTF-8 JSON bytes, as a Buffer. */
function frame(jsonBytes: Buffer): Buffer {
  const out = Buffer.alloc(4 + jsonBytes.length);
  out.writeUInt32BE(jsonBytes.length, 0);
  jsonBytes.copy(out, 4);
  return out;
}

function buildFixture(): GoldenFixture {
  const vectors: GoldenVector[] = VECTORS.map((v) => {
    const frameBytes = Buffer.from(encodeHeaderFrame(v.value));
    const jsonBytes = frameBytes.subarray(4);
    return {
      name: v.name,
      note: v.note,
      json: jsonBytes.toString('utf8'),
      jsonByteLength: jsonBytes.length,
      frameBase64: frameBytes.toString('base64'),
    };
  });
  return {
    _readme: [
      'Golden wire-protocol frames for the centraid tunnel (issue #263 / #419).',
      'Source of truth: packages/tunnel/src/wire-conformance.test.ts. Regenerate',
      'with UPDATE_GOLDEN=1. Read identically by the Swift (XCTest) and Kotlin',
      '(JUnit) conformance tests in apps/mobile/modules/centraid-tunnel.',
      '',
      'frameBase64 = base64( u32BE(jsonByteLength) ++ utf8(json) ). Every',
      'implementation MUST reproduce frameBase64 byte-for-byte when it frames the',
      'exact `json` string, and MUST parse jsonByteLength back from the prefix.',
      'Object encoding is round-tripped (not byte-compared) because JSON key',
      'order differs across serializers; `json` is the Node canonical form.',
    ],
    version: 1,
    alpns: {
      pair: PAIR_ALPN,
      tunnel: TUNNEL_ALPN,
      gwPair: GW_PAIR_ALPN,
      pairBytesBase64: Buffer.from(alpnBytes(PAIR_ALPN)).toString('base64'),
      tunnelBytesBase64: Buffer.from(alpnBytes(TUNNEL_ALPN)).toString('base64'),
      gwPairBytesBase64: Buffer.from(alpnBytes(GW_PAIR_ALPN)).toString('base64'),
    },
    caps: {
      maxHeaderFrameBytes: MAX_HEADER_FRAME_BYTES,
      maxRequestBodyBytes: MAX_REQUEST_BODY_BYTES,
      readChunkBytes: READ_CHUNK_BYTES,
    },
    hopByHopHeaders: HOP_BY_HOP,
    vectors,
  };
}

function loadFixture(): GoldenFixture {
  return JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8')) as GoldenFixture;
}

// Regenerate on demand. Kept deterministic so a no-op regen is a no-op diff.
if (process.env.UPDATE_GOLDEN) {
  fs.mkdirSync(path.dirname(FIXTURE_PATH), { recursive: true });
  fs.writeFileSync(FIXTURE_PATH, `${JSON.stringify(buildFixture(), null, 2)}\n`, 'utf8');
}

/** A recv half over a fixed byte buffer — feeds readHeaderFrame in-process. */
function bufferRecv(bytes: Buffer): { readExact(size: number): Promise<Array<number>> } {
  let offset = 0;
  return {
    async readExact(size: number): Promise<Array<number>> {
      const slice = bytes.subarray(offset, offset + size);
      if (slice.length !== size) throw new Error('tunnel: unexpected EOF');
      offset += size;
      return Array.from(slice);
    },
  };
}

describe('wire golden fixture', () => {
  const fixture = loadFixture();

  it('is in sync with the current encoder (regen with UPDATE_GOLDEN=1)', () => {
    expect(fixture).toEqual(buildFixture());
  });

  it('pins the caps constants', () => {
    expect(fixture.caps.maxHeaderFrameBytes).toBe(MAX_HEADER_FRAME_BYTES);
    expect(fixture.caps.maxRequestBodyBytes).toBe(MAX_REQUEST_BODY_BYTES);
    expect(fixture.caps.readChunkBytes).toBe(READ_CHUNK_BYTES);
    expect(MAX_HEADER_FRAME_BYTES).toBe(256 * 1024);
    expect(MAX_REQUEST_BODY_BYTES).toBe(32 * 1024 * 1024);
    expect(READ_CHUNK_BYTES).toBe(64 * 1024);
  });

  it('pins the ALPN strings and their byte encodings', () => {
    expect(fixture.alpns.pair).toBe('centraid/pair/1');
    expect(fixture.alpns.tunnel).toBe('centraid/tunnel/1');
    expect(fixture.alpns.gwPair).toBe('centraid/gw-pair/1');
    for (const [alpn, b64] of [
      [PAIR_ALPN, fixture.alpns.pairBytesBase64],
      [TUNNEL_ALPN, fixture.alpns.tunnelBytesBase64],
      [GW_PAIR_ALPN, fixture.alpns.gwPairBytesBase64],
    ] as const) {
      expect(Buffer.from(alpnBytes(alpn)).toString('base64')).toBe(b64);
    }
  });

  it('pins the hop-by-hop header set', () => {
    expect(new Set(fixture.hopByHopHeaders)).toEqual(new Set(HOP_BY_HOP));
  });
});

describe.each(VECTORS)('wire vector $name', ({ name, value }) => {
  const vector = loadFixture().vectors.find((v) => v.name === name)!;

  it('has a fixture entry', () => {
    expect(vector, `missing golden vector ${name}`).toBeTruthy();
  });

  it('frames the canonical json string to the golden bytes', () => {
    const framed = frame(Buffer.from(vector.json, 'utf8'));
    expect(framed.toString('base64')).toBe(vector.frameBase64);
    expect(framed.readUInt32BE(0)).toBe(vector.jsonByteLength);
    expect(Buffer.byteLength(vector.json, 'utf8')).toBe(vector.jsonByteLength);
  });

  it('encodeHeaderFrame reproduces the golden bytes', () => {
    // Node is the canonical generator: its object encoding is byte-exact.
    expect(Buffer.from(encodeHeaderFrame(value)).toString('base64')).toBe(vector.frameBase64);
  });

  it('readHeaderFrame round-trips the golden frame back to the object', async () => {
    const bytes = Buffer.from(vector.frameBase64, 'base64');
    const decoded = await readHeaderFrame(bufferRecv(bytes));
    expect(decoded).toEqual(value);
  });
});

describe('framing bounds', () => {
  // The cap is enforced uniformly on the READ path in every implementation
  // (protocol.ts readHeaderFrame, Swift/Kotlin readHeaderFrame). A length
  // prefix over the cap is rejected before the body is read, so a crafted
  // 4-byte prefix exercises it without allocating a 256 KiB frame.
  it('rejects a header frame whose length prefix exceeds the cap', async () => {
    const prefix = Buffer.alloc(4);
    prefix.writeUInt32BE(MAX_HEADER_FRAME_BYTES + 1, 0);
    await expect(readHeaderFrame(bufferRecv(prefix))).rejects.toThrow(/out of bounds/);
  });

  it('rejects a zero-length header frame on read', async () => {
    const zero = frame(Buffer.alloc(0));
    await expect(readHeaderFrame(bufferRecv(zero))).rejects.toThrow(/out of bounds/);
  });
});
