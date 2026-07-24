import { describe, expect, test } from 'vitest';
import { fc } from '@centraid/test-kit/fast-check';
import {
  encodeHeaderFrame,
  MAX_HEADER_FRAME_BYTES,
  parsePairQrPayload,
  sanitizeHeaders,
} from './protocol.js';

/**
 * Tunnel wire properties (#532 core expansion).
 *
 * Model: header frames are length-prefixed JSON; pair QR parse is fail-closed;
 * hop-by-hop headers never cross the tunnel.
 */
describe('tunnel wire property', () => {
  test('encodeHeaderFrame length prefix matches JSON byte length', () => {
    fc.assert(
      fc.property(
        fc.record({
          method: fc.constantFrom('GET', 'POST', 'PUT', 'DELETE'),
          target: fc.stringMatching(/^\/[a-z0-9/_-]{0,40}$/),
          headers: fc.dictionary(
            fc.stringMatching(/^[a-z-]{1,12}$/),
            fc.string({ minLength: 0, maxLength: 24 }),
            { maxKeys: 6 },
          ),
        }),
        (header) => {
          const frame = Buffer.from(encodeHeaderFrame(header));
          const len = frame.readUInt32BE(0);
          expect(len).toBe(frame.length - 4);
          expect(JSON.parse(frame.subarray(4).toString('utf8'))).toEqual(header);
          expect(len).toBeLessThanOrEqual(MAX_HEADER_FRAME_BYTES);
        },
      ),
      { numRuns: 40, seed: 53280 },
    );
  });

  test('parsePairQrPayload accepts only well-formed v1 centraid-pair payloads', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 40 }),
        fc.string({ minLength: 1, maxLength: 16 }),
        (ticket, code) => {
          const raw = JSON.stringify({ v: 1, kind: 'centraid-pair', ticket, code });
          expect(parsePairQrPayload(raw)).toEqual({
            v: 1,
            kind: 'centraid-pair',
            ticket,
            code,
          });
        },
      ),
      { numRuns: 32, seed: 53281 },
    );
  });

  test('parsePairQrPayload fails closed on garbage and wrong kind/version', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.string({ minLength: 0, maxLength: 40 }),
          fc.jsonValue().map((v) => JSON.stringify(v)),
          fc.constant(JSON.stringify({ v: 2, kind: 'centraid-pair', ticket: 't', code: 'c' })),
          fc.constant(JSON.stringify({ v: 1, kind: 'other', ticket: 't', code: 'c' })),
          fc.constant(JSON.stringify({ v: 1, kind: 'centraid-pair', ticket: 1, code: 'c' })),
        ),
        (raw) => {
          let shouldAccept = false;
          try {
            const obj = JSON.parse(raw) as Record<string, unknown>;
            shouldAccept =
              obj.v === 1 &&
              obj.kind === 'centraid-pair' &&
              typeof obj.ticket === 'string' &&
              typeof obj.code === 'string';
          } catch {
            shouldAccept = false;
          }
          const parsed = parsePairQrPayload(raw);
          if (shouldAccept) {
            expect(parsed).toBeDefined();
          } else {
            expect(parsed).toBeUndefined();
          }
        },
      ),
      { numRuns: 48, seed: 53282 },
    );
  });

  test('sanitizeHeaders lowercases names and strips hop-by-hop', () => {
    const hop = [
      'Connection',
      'Keep-Alive',
      'Proxy-Authenticate',
      'Proxy-Authorization',
      'Proxy-Connection',
      'TE',
      'Trailer',
      'Transfer-Encoding',
      'Upgrade',
    ];
    fc.assert(
      fc.property(
        fc.dictionary(
          fc.constantFrom(...hop, 'Content-Type', 'Authorization', 'X-Centraid-Token'),
          fc.string({ minLength: 1, maxLength: 20 }),
          { minKeys: 1, maxKeys: 8 },
        ),
        (headers) => {
          const out = sanitizeHeaders(headers);
          for (const key of Object.keys(out)) {
            expect(key).toBe(key.toLowerCase());
            expect(
              [
                'connection',
                'keep-alive',
                'proxy-authenticate',
                'proxy-authorization',
                'proxy-connection',
                'te',
                'trailer',
                'transfer-encoding',
                'upgrade',
              ].includes(key),
            ).toBe(false);
          }
          if ('Content-Type' in headers || 'content-type' in headers) {
            expect(out['content-type']).toBeDefined();
          }
        },
      ),
      { numRuns: 32, seed: 53283 },
    );
  });

  test('encodeHeaderFrame is deterministic for the same object shape', () => {
    fc.assert(
      fc.property(fc.constantFrom({ method: 'GET', target: '/centraid/', headers: {} }), (h) => {
        expect(encodeHeaderFrame(h)).toEqual(encodeHeaderFrame(h));
      }),
      { numRuns: 8, seed: 53284 },
    );
  });
});
