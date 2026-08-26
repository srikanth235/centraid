// The "corrupt EXIF" trap (#721): holds `extractBlobMeta` to its promise —
// degrade to "a blob with no metadata", never throw.

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
    // The real first IFD0 entry survives the inflated count; only the
    // fictitious extras past it are attempted, bounds-checked.
    let meta: ReturnType<typeof extractBlobMeta> | undefined;
    expect(() => {
      meta = extractBlobMeta(entryCountOverflowJpeg(), "image/jpeg");
    }).not.toThrow();
    expect(meta?.captured_at).toBe("2024-06-01T10:30:00");
  });

  test("an epoch-zero DateTimeOriginal is reported honestly, not swallowed as absence", () => {
    const meta = extractBlobMeta(epochZeroDateTimeJpeg(), "image/jpeg");
    // A dead camera clock really writes this — never special-cased into absence.
    expect(meta.captured_at).toBe("1970-01-01T00:00:00");
  });

  test("every corrupt variant stays throw-free with GPS retained AND stripped", () => {
    // keepLocation walks a second code path inside the same try/catch.
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
