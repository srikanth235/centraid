// The "corrupt EXIF" trap (issue #721 D1). blob.test.ts proves the happy
// path once, inline; this file is the adversary — every shape a real spool
// actually receives that is NOT a clean camera JPEG: a truncated upload, a
// foreign byte-order marker, an offset a bit-flip sent past EOF, an entry
// count no buffer could back, a dead-clock epoch-zero timestamp, and a JPEG
// with no EXIF at all. `extractBlobMeta`'s own header promises degradation
// to "a blob with no metadata", never a throw — this file is what holds it
// to that promise, one corrupt shape at a time.

import { describe, expect, test } from "vitest";

import {
  badTiffMagicJpeg,
  entryCountOverflowJpeg,
  epochZeroDateTimeJpeg,
  ifdOffsetPastEofJpeg,
  noApp1Jpeg,
  truncatedApp1Jpeg,
  validExifJpeg,
} from "./exif-fixtures.js";
import { extractBlobMeta } from "./pipeline.js";

describe("adversarial EXIF parsing", () => {
  test("a well-formed JPEG still parses its capture time", () => {
    const meta = extractBlobMeta(validExifJpeg(), "image/jpeg");
    expect(meta.captured_at).toBe("2024-06-01T10:30:00");
  });

  test.each([
    ["APP1 truncated mid TIFF-header", truncatedApp1Jpeg()],
    ["a byte-order marker that is neither 'II' nor 'MM'", badTiffMagicJpeg()],
    ["an IFD0 offset tens of megabytes past EOF", ifdOffsetPastEofJpeg()],
    ["no APP1/EXIF segment at all", noApp1Jpeg()],
  ])("%s never throws, and reports no captured_at", (_label, bytes) => {
    let meta: ReturnType<typeof extractBlobMeta> | undefined;
    expect(() => {
      meta = extractBlobMeta(bytes, "image/jpeg");
    }).not.toThrow();
    expect(meta?.captured_at).toBeUndefined();
  });

  test("an entry-count overflow never throws, and does not cost the real entry its data", () => {
    // Unlike the variants above, the first (real, correctly laid out) IFD0
    // entry survives an inflated entry COUNT — only the fictitious extras
    // past it are ever attempted, and the bounds check stops the walk before
    // any of those reads memory outside the buffer. The honest outcome here
    // is "still parses", not "loses the tag" — a stricter and more useful
    // guarantee than merely not crashing.
    let meta: ReturnType<typeof extractBlobMeta> | undefined;
    expect(() => {
      meta = extractBlobMeta(entryCountOverflowJpeg(), "image/jpeg");
    }).not.toThrow();
    expect(meta?.captured_at).toBe("2024-06-01T10:30:00");
  });

  test("an epoch-zero DateTimeOriginal is reported honestly, not swallowed as absence", () => {
    const meta = extractBlobMeta(epochZeroDateTimeJpeg(), "image/jpeg");
    // A camera with a dead clock really does write this — the parser must
    // not special-case it into "no data", the one thing genuine absence and
    // a real epoch-zero timestamp must never look alike as.
    expect(meta.captured_at).toBe("1970-01-01T00:00:00");
  });

  test("every corrupt variant stays throw-free with GPS retained AND stripped", () => {
    // keepLocation walks a second code path (has_location / lat / lon) inside
    // the same try/catch — both gate settings must survive every variant.
    for (const bytes of [
      validExifJpeg(),
      truncatedApp1Jpeg(),
      badTiffMagicJpeg(),
      ifdOffsetPastEofJpeg(),
      entryCountOverflowJpeg(),
      noApp1Jpeg(),
      epochZeroDateTimeJpeg(),
    ]) {
      expect(() =>
        extractBlobMeta(bytes, "image/jpeg", { keepLocation: true })
      ).not.toThrow();
      expect(() =>
        extractBlobMeta(bytes, "image/jpeg", { keepLocation: false })
      ).not.toThrow();
    }
  });

  test("no corrupt variant ever fabricates GPS coordinates it never carried", () => {
    for (const bytes of [
      truncatedApp1Jpeg(),
      badTiffMagicJpeg(),
      ifdOffsetPastEofJpeg(),
      entryCountOverflowJpeg(),
      noApp1Jpeg(),
      epochZeroDateTimeJpeg(),
    ]) {
      const meta = extractBlobMeta(bytes, "image/jpeg", {
        keepLocation: true,
      });
      expect(meta.has_location).toBeUndefined();
      expect(meta.latitude).toBeUndefined();
      expect(meta.longitude).toBeUndefined();
    }
  });
});
