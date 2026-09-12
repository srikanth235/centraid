import { describe, expect, it } from "vitest";

import {
  baseMediaType,
  filenameFor,
  INLINE_EXECUTABLE_MEDIA_TYPES,
  mayServeInline,
  mediaResponse,
  parseMediaUrl,
} from "./media-response-core.js";
import type { SeatBlobAnswer } from "./media-response-core.js";

const DIGEST = "a".repeat(64);

describe("parsing the URL", () => {
  it("takes a sixty-four-hex digest under the blob route", () => {
    expect(parseMediaUrl(`centraid://blob/${DIGEST}`)).toStrictEqual({
      digest: DIGEST,
      download: false,
    });
    expect(
      parseMediaUrl(`centraid://blob/${DIGEST}?download=1`)?.download
    ).toBe(true);
    // Case is normalised: the vault's column is lowercase hex.
    expect(
      parseMediaUrl(`centraid://blob/${DIGEST.toUpperCase()}`)?.digest
    ).toBe(DIGEST);
  });

  it("refuses everything else before anything is asked of the seat", () => {
    for (const bad of [
      "",
      "not a url",
      "https://example.com/x",
      `centraid://blob/${"a".repeat(63)}`,
      `centraid://blob/${"a".repeat(65)}`,
      `centraid://blob/${"g".repeat(64)}`,
      "centraid://blob/../../etc/passwd",
      `centraid://elsewhere/${DIGEST}`,
      "centraid://blob/",
    ]) {
      expect(parseMediaUrl(bad), bad).toBeNull();
    }
  });
});

describe("the never-inline list", () => {
  it("is the gateway's list, and parameters do not hide a type", () => {
    expect([...INLINE_EXECUTABLE_MEDIA_TYPES]).toStrictEqual([
      "text/html",
      "application/xhtml+xml",
      "image/svg+xml",
    ]);
    expect(mayServeInline("text/html")).toBe(false);
    expect(mayServeInline("TEXT/HTML; charset=utf-8")).toBe(false);
    expect(mayServeInline(" image/svg+xml ")).toBe(false);
    expect(mayServeInline("video/mp4")).toBe(true);
    expect(baseMediaType("Video/MP4; codecs=avc1")).toBe("video/mp4");
  });

  it("serves an executable type as an attachment even when nothing asked for a download", () => {
    const response = mediaResponse({
      answer: bytes({ mediaType: "text/html", complete: true }),
      digest: DIGEST,
      download: false,
    });
    expect(response.headers["Content-Disposition"]).toBe(
      `attachment; filename="${filenameFor(DIGEST)}"`
    );
    // nosniff and the sandbox CSP ride along, so even a mislabelled type is
    // inert.
    expect(response.headers["X-Content-Type-Options"]).toBe("nosniff");
    expect(response.headers["Content-Security-Policy"]).toBe("sandbox");
  });

  it("serves an inline-safe type inline, unless a download was asked for", () => {
    expect(
      mediaResponse({
        answer: bytes({ mediaType: "video/mp4", complete: true }),
        digest: DIGEST,
        download: false,
      }).headers["Content-Disposition"]
    ).toMatch(/^inline;/u);
    expect(
      mediaResponse({
        answer: bytes({ mediaType: "video/mp4", complete: true }),
        digest: DIGEST,
        download: true,
      }).headers["Content-Disposition"]
    ).toMatch(/^attachment;/u);
  });
});

function bytes(
  overrides: Partial<Extract<SeatBlobAnswer, { kind: "bytes" }>> = {}
) {
  return {
    kind: "bytes" as const,
    start: 0,
    end: 99,
    total: 1000,
    complete: false,
    partial: false,
    mediaType: "video/mp4",
    ...overrides,
  };
}

describe("the statuses", () => {
  it("is 200 with a Content-Length when nothing asked for a range", () => {
    const response = mediaResponse({
      answer: bytes({ partial: false, start: 0, end: 9 }),
      digest: DIGEST,
      download: false,
    });
    expect(response.status).toBe(200);
    expect(response.headers["Content-Length"]).toBe("10");
    expect(response.headers["Content-Range"]).toBeUndefined();
    expect(response.headers["Accept-Ranges"]).toBe("bytes");
    expect(response.body).toBe(true);
  });

  it("is 206 with a Content-Range when a range was asked for", () => {
    const response = mediaResponse({
      answer: bytes({ partial: true, start: 100, end: 199, total: 4096 }),
      digest: DIGEST,
      download: false,
    });
    expect(response.status).toBe(206);
    expect(response.headers["Content-Range"]).toBe("bytes 100-199/4096");
    expect(response.headers["Content-Length"]).toBe("100");
  });

  it("is still a 206 when the answer is SHORT of the range asked for", () => {
    // The seat clamps to what arrived; the shell reports what it got. Short is
    // what makes progressive playback work.
    const response = mediaResponse({
      answer: bytes({ partial: true, start: 256, end: 511, total: 4096 }),
      digest: DIGEST,
      download: false,
    });
    expect(response.status).toBe(206);
    expect(response.headers["Content-Range"]).toBe("bytes 256-511/4096");
  });

  it("is 416 only for a blob whose size is settled", () => {
    const response = mediaResponse({
      answer: { kind: "unsatisfiable", size: 4096 },
      digest: DIGEST,
      download: false,
    });
    expect(response.status).toBe(416);
    expect(response.headers["Content-Range"]).toBe("bytes */4096");
    expect(response.headers["Cache-Control"]).toBe("no-store");
    expect(response.body).toBe(false);
  });

  /**
   * THE RULING, as an assertion. A 416 here would end playback for good.
   */
  it("is 503 with Retry-After — never 416 — for a range inside a declared total", () => {
    const response = mediaResponse({
      answer: {
        kind: "still-arriving",
        received: 512,
        total: 4096,
        mediaType: "video/mp4",
      },
      digest: DIGEST,
      download: false,
    });
    expect(response.status).not.toBe(416);
    expect(response.status).toBe(503);
    expect(response.headers["Retry-After"]).toBe("1");
    expect(response.headers["X-Centraid-Received"]).toBe("512");
    expect(response.headers["Accept-Ranges"]).toBe("bytes");
  });

  it("is 404 for a blob nobody has, never an empty 200", () => {
    const response = mediaResponse({
      answer: { kind: "not-found" },
      digest: DIGEST,
      download: false,
    });
    expect(response.status).toBe(404);
    expect(response.body).toBe(false);
  });
});

describe("caching", () => {
  it("is immutable only once the blob is complete", () => {
    expect(
      mediaResponse({
        answer: bytes({ complete: true }),
        digest: DIGEST,
        download: false,
      }).headers["Cache-Control"]
    ).toBe("private, max-age=31536000, immutable");
    // A PREFIX MUST NOT BE CACHED: an `immutable` truncated video survives a
    // restart, and nothing ever asks for the rest.
    expect(
      mediaResponse({
        answer: bytes({ complete: false }),
        digest: DIGEST,
        download: false,
      }).headers["Cache-Control"]
    ).toBe("no-store");
  });

  it("answers 304 for a matching ETag on a settled blob and not on an arriving one", () => {
    const etag = `"${DIGEST}"`;
    expect(
      mediaResponse({
        answer: bytes({ complete: true }),
        digest: DIGEST,
        download: false,
        ifNoneMatch: etag,
      }).status
    ).toBe(304);
    expect(
      mediaResponse({
        answer: bytes({ complete: false }),
        digest: DIGEST,
        download: false,
        ifNoneMatch: etag,
      }).status
    ).toBe(200);
    // A different ETag is not a match.
    expect(
      mediaResponse({
        answer: bytes({ complete: true }),
        digest: DIGEST,
        download: false,
        ifNoneMatch: '"b"',
      }).status
    ).toBe(200);
  });

  it("names the file by its digest, so nothing a member typed reaches a header", () => {
    expect(filenameFor(DIGEST)).toBe("aaaaaaaaaaaa");
    const disposition = mediaResponse({
      answer: bytes({ complete: true }),
      digest: DIGEST,
      download: false,
    }).headers["Content-Disposition"] as string;
    expect(disposition).not.toMatch(/[\r\n\\]/u);
  });
});
