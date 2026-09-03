import { describe, expect, test } from "vitest";

import { fc } from "@centraid/test-kit/fast-check";

import {
  alpnBytes,
  encodeHeaderFrame,
  isPeerPlaneTarget,
  MAX_HEADER_FRAME_BYTES,
  parsePairQrPayload,
  PEER_PLANE_PREFIX,
  sanitizeHeaders,
} from "./protocol.js";

describe("tunnel wire property", () => {
  test("encodeHeaderFrame length prefix matches JSON byte length", () => {
    fc.assert(
      fc.property(
        fc.record({
          method: fc.constantFrom("GET", "POST", "PUT", "DELETE"),
          target: fc.stringMatching(/^\/[a-z0-9/_-]{0,40}$/u),
          headers: fc.dictionary(
            fc.stringMatching(/^[a-z-]{1,12}$/u),
            fc.string({ minLength: 0, maxLength: 24 }),
            { maxKeys: 6 }
          ),
        }),
        (header) => {
          const frame = Buffer.from(encodeHeaderFrame(header));
          const len = frame.readUInt32BE(0);
          expect(len).toBe(frame.length - 4);
          const encodedHeader: unknown = JSON.parse(
            JSON.stringify(header) as string
          );
          expect(JSON.parse(frame.subarray(4).toString("utf8"))).toStrictEqual(
            encodedHeader
          );
          expect(len).toBeLessThanOrEqual(MAX_HEADER_FRAME_BYTES);
        }
      ),
      { numRuns: 40, seed: 53280 }
    );
  });

  test("parsePairQrPayload accepts only well-formed v1 centraid-pair payloads", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 40 }),
        fc.string({ minLength: 1, maxLength: 16 }),
        (ticket, code) => {
          const raw = JSON.stringify({
            v: 1,
            kind: "centraid-pair",
            ticket,
            code,
          });
          expect(parsePairQrPayload(raw)).toStrictEqual({
            v: 1,
            kind: "centraid-pair",
            ticket,
            code,
          });
        }
      ),
      { numRuns: 32, seed: 53281 }
    );
  });

  test("parsePairQrPayload fails closed on garbage and wrong kind/version", () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.string({ minLength: 0, maxLength: 40 }),
          fc.jsonValue().map((v) => JSON.stringify(v)),
          fc.constant(
            JSON.stringify({
              v: 2,
              kind: "centraid-pair",
              ticket: "t",
              code: "c",
            })
          ),
          fc.constant(
            JSON.stringify({ v: 1, kind: "other", ticket: "t", code: "c" })
          ),
          fc.constant(
            JSON.stringify({
              v: 1,
              kind: "centraid-pair",
              ticket: 1,
              code: "c",
            })
          )
        ),
        (raw) => {
          let shouldAccept = false;
          try {
            const obj = JSON.parse(raw) as Record<string, unknown>;
            shouldAccept =
              obj.v === 1 &&
              obj.kind === "centraid-pair" &&
              typeof obj.ticket === "string" &&
              typeof obj.code === "string";
          } catch {
            shouldAccept = false;
          }
          const parsed = parsePairQrPayload(raw);
          expect(parsed === undefined).toBe(!shouldAccept);
        }
      ),
      { numRuns: 48, seed: 53282 }
    );
  });

  test("sanitizeHeaders lowercases names and strips hop-by-hop", () => {
    const hop = [
      "Connection",
      "Keep-Alive",
      "Proxy-Authenticate",
      "Proxy-Authorization",
      "Proxy-Connection",
      "TE",
      "Trailer",
      "Transfer-Encoding",
      "Upgrade",
    ];
    fc.assert(
      fc.property(
        fc.dictionary(
          fc.constantFrom(
            ...hop,
            "Content-Type",
            "Authorization",
            "X-Centraid-Token"
          ),
          fc.string({ minLength: 1, maxLength: 20 }),
          { minKeys: 1, maxKeys: 8 }
        ),
        (headers) => {
          const out = sanitizeHeaders(headers);
          for (const key of Object.keys(out)) {
            expect(key).toBe(key.toLowerCase());
            expect([
              "connection",
              "keep-alive",
              "proxy-authenticate",
              "proxy-authorization",
              "proxy-connection",
              "te",
              "trailer",
              "transfer-encoding",
              "upgrade",
            ]).not.toContain(key);
          }
          expect(
            !("Content-Type" in headers || "content-type" in headers) ||
              out["content-type"] !== undefined
          ).toBe(true);
        }
      ),
      { numRuns: 32, seed: 53283 }
    );
  });

  test("encodeHeaderFrame is deterministic for the same object shape", () => {
    fc.assert(
      fc.property(
        fc.constantFrom({ method: "GET", target: "/centraid/", headers: {} }),
        (h) => {
          expect(encodeHeaderFrame(h)).toStrictEqual(encodeHeaderFrame(h));
        }
      ),
      { numRuns: 8, seed: 53284 }
    );
  });

  test("peer-plane targets stay confined after URL parsing", () => {
    for (const target of [
      "/centraid/_peer/link/redeem",
      "/centraid/_peer/blobs/a1b2c3?range=0-1023",
      "/centraid/_peer/route/assert",
      "/centraid/_peer/x#fragment",
    ]) {
      expect(isPeerPlaneTarget(target)).toBe(true);
    }

    for (const target of [
      undefined,
      42,
      "/centraid/_gateway/tunnel/authorize",
      "/centraid/_vault/blobs",
      "/centraid/_peer",
      "/centraid/_peer/",
      "/centraid/_peerish/x",
      "/centraid/_peer/../_gateway/devices",
      "/centraid/_peer/./../_gateway",
      "/centraid/_peer/%2e%2e/_gateway",
      "/centraid/_peer/a%2f..%2fb",
      "/centraid/_peer/a\\..\\b",
      "/centraid/_peer/a b",
      "//centraid/_peer/x",
      "",
    ]) {
      expect(isPeerPlaneTarget(target)).toBe(false);
    }
  });

  test("a dot inside a segment is not a dot segment", () => {
    for (const target of [
      `${PEER_PLANE_PREFIX}blobs/a.b`,
      `${PEER_PLANE_PREFIX}route/v1.2/assert`,
      `${PEER_PLANE_PREFIX}...`,
      `${PEER_PLANE_PREFIX}a..b`,
    ])
      expect(isPeerPlaneTarget(target)).toBe(true);

    for (const target of [
      `${PEER_PLANE_PREFIX}../x`,
      `${PEER_PLANE_PREFIX}./x`,
      `${PEER_PLANE_PREFIX}x/..`,
      `${PEER_PLANE_PREFIX}x/.`,
      `${PEER_PLANE_PREFIX}x/../y`,
    ])
      expect(isPeerPlaneTarget(target)).toBe(false);
  });

  test("the path must extend the prefix, not merely start with it", () => {
    expect(isPeerPlaneTarget(PEER_PLANE_PREFIX)).toBe(false);
    expect(isPeerPlaneTarget(`${PEER_PLANE_PREFIX}?a=1`)).toBe(false);
    expect(isPeerPlaneTarget(`${PEER_PLANE_PREFIX}#f`)).toBe(false);
    expect(isPeerPlaneTarget(`${PEER_PLANE_PREFIX}x`)).toBe(true);
    expect(isPeerPlaneTarget(`${PEER_PLANE_PREFIX}x?a=1`)).toBe(true);
  });

  test("a target the Rust lane cannot represent is refused", () => {
    const high = "\u{D800}";
    const highLast = "\u{DBFF}";
    const low = "\u{DC00}";
    const lowLast = "\u{DFFF}";

    for (const suffix of [
      high, // lone high, at the end — nothing follows it
      highLast,
      low, // lone low, standing alone
      lowLast,
      `${high}x`, // high followed by something that is not a low
      `${high}${high}`, // …including another high
      `${low}${low}`,
      `x${low}`,
    ])
      expect(isPeerPlaneTarget(`${PEER_PLANE_PREFIX}${suffix}`)).toBe(false);

    for (const pair of [
      `${high}${low}`,
      `${high}${lowLast}`,
      `${highLast}${low}`,
      `${highLast}${lowLast}`,
      "\u{1F600}", // the same thing spelled as the character it encodes
    ])
      expect(isPeerPlaneTarget(`${PEER_PLANE_PREFIX}${pair}`)).toBe(true);

    expect(isPeerPlaneTarget(`${PEER_PLANE_PREFIX}${high}${low}${high}`)).toBe(
      false
    );
    expect(isPeerPlaneTarget(`${PEER_PLANE_PREFIX}${high}${low}/..`)).toBe(
      false
    );
  });

  test("encodeHeaderFrame and alpnBytes count UTF-8 bytes, not code units", () => {
    const frame = Buffer.from(
      encodeHeaderFrame({
        method: "GET",
        target: "/centraid/_peer/é",
        headers: {},
      })
    );
    expect(frame.readUInt32BE(0)).toBe(frame.length - 4);
    expect(frame.length - 4).toBe(
      Buffer.byteLength(
        JSON.stringify({
          method: "GET",
          target: "/centraid/_peer/é",
          headers: {},
        }),
        "utf8"
      )
    );

    expect(alpnBytes("centraid/1")).toStrictEqual([
      ...Buffer.from("centraid/1", "utf8"),
    ]);
    expect(alpnBytes("é")).toStrictEqual([0xc3, 0xa9]);
  });
});
