import type { IncomingMessage, ServerResponse } from "node:http";
import zlib from "node:zlib";

import { describe, expect, it } from "vitest";

import {
  compress,
  DYNAMIC_QUALITY,
  MIN_COMPRESS_BYTES,
  negotiateEncoding,
  sendJsonNegotiated,
} from "./compression.js";

interface Captured {
  statusCode: number;
  headers: Record<string, string>;
  body: Buffer;
}

function mockRes(): { res: ServerResponse; data: Captured } {
  const data: Captured = { statusCode: 0, headers: {}, body: Buffer.alloc(0) };
  const res = {
    statusCode: 0,
    setHeader(k: string, v: string) {
      data.headers[k] = v;
    },
    end(b?: Buffer) {
      data.body = b ?? Buffer.alloc(0);
      data.statusCode = (this as { statusCode: number }).statusCode || 200;
    },
  } as unknown as ServerResponse;
  Object.defineProperty(res, "statusCode", {
    get() {
      return data.statusCode;
    },
    set(v: number) {
      data.statusCode = v;
    },
  });
  return { res, data };
}

function mockReq(headers: Record<string, string> = {}): IncomingMessage {
  return { headers } as unknown as IncomingMessage;
}

describe("compression", () => {
  describe("negotiateEncoding — Accept-Encoding matrix", () => {
    it("prefers brotli when both are offered", () => {
      expect(negotiateEncoding("gzip, deflate, br")).toBe("br");
    });

    it("falls back to gzip when br is absent", () => {
      expect(negotiateEncoding("gzip, deflate")).toBe("gzip");
    });

    it("returns null when neither br nor gzip is acceptable", () => {
      expect(negotiateEncoding("deflate")).toBeNull();
      expect(negotiateEncoding("identity")).toBeNull();
    });

    it("returns null for an absent/empty header — the SW/browser-transport opt-out", () => {
      expect(negotiateEncoding(undefined)).toBeNull();
      expect(negotiateEncoding("")).toBeNull();
    });

    it("honours q=0 as a disqualification", () => {
      expect(negotiateEncoding("br;q=0, gzip")).toBe("gzip");
      expect(negotiateEncoding("br;q=0, gzip;q=0")).toBeNull();
    });

    it("treats a wildcard as offering both (br preferred)", () => {
      expect(negotiateEncoding("*")).toBe("br");
    });

    it("folds a repeated (array) header", () => {
      expect(negotiateEncoding(["gzip", "br"])).toBe("br");
    });
  });

  describe("compress — round-trips", () => {
    const payload = Buffer.from('{"rows":[' + '"x",'.repeat(2000) + '"end"]}');

    it("brotli output decompresses to the original", async () => {
      const out = await compress(payload, "br", DYNAMIC_QUALITY);
      expect(out.length).toBeLessThan(payload.length);
      expect(zlib.brotliDecompressSync(out).equals(payload)).toBe(true);
    });

    it("gzip output decompresses to the original", async () => {
      const out = await compress(payload, "gzip", DYNAMIC_QUALITY);
      expect(out.length).toBeLessThan(payload.length);
      expect(zlib.gunzipSync(out).equals(payload)).toBe(true);
    });
  });

  describe(sendJsonNegotiated, () => {
    const big = {
      rows: Array.from({ length: 500 }, (_, i) => ({ i, name: `row-${i}` })),
    };

    it("compresses a large body with brotli and sets Vary + Content-Encoding", async () => {
      const { res, data } = mockRes();
      await sendJsonNegotiated(
        mockReq({ "accept-encoding": "br" }),
        res,
        200,
        big
      );
      expect(data.statusCode).toBe(200);
      expect(data.headers["Content-Encoding"]).toBe("br");
      expect(data.headers["Vary"]).toBe("Accept-Encoding");
      // Body is the compressed form and decodes back to the JSON.
      expect(
        JSON.parse(zlib.brotliDecompressSync(data.body).toString("utf8"))
      ).toStrictEqual(big);
    });

    it("uses gzip when br is not offered", async () => {
      const { res, data } = mockRes();
      await sendJsonNegotiated(
        mockReq({ "accept-encoding": "gzip" }),
        res,
        200,
        big
      );
      expect(data.headers["Content-Encoding"]).toBe("gzip");
      expect(
        JSON.parse(zlib.gunzipSync(data.body).toString("utf8"))
      ).toStrictEqual(big);
    });

    it("ships raw JSON (no Content-Encoding) when the request offers no encoding", async () => {
      const { res, data } = mockRes();
      await sendJsonNegotiated(mockReq(), res, 200, big);
      expect(data.headers["Content-Encoding"]).toBeUndefined();
      // Still sets Vary so a cache keys per Accept-Encoding.
      expect(data.headers["Vary"]).toBe("Accept-Encoding");
      expect(JSON.parse(data.body.toString("utf8"))).toStrictEqual(big);
    });

    it("skips compression for a sub-1KB body even when br is offered", async () => {
      const small = { ok: true };
      expect(Buffer.byteLength(JSON.stringify(small))).toBeLessThan(
        MIN_COMPRESS_BYTES
      );
      const { res, data } = mockRes();
      await sendJsonNegotiated(
        mockReq({ "accept-encoding": "br" }),
        res,
        200,
        small
      );
      expect(data.headers["Content-Encoding"]).toBeUndefined();
      expect(JSON.parse(data.body.toString("utf8"))).toStrictEqual(small);
    });
  });
});
