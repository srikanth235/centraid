// Adversarial EXIF/JPEG byte builders (issue #721 D1) — the "corrupt EXIF"
// trap. `extractBlobMeta` (pipeline.ts) hands parseJpegExif bytes from
// arbitrary cameras, screenshot tools, re-encoders, and partially-spooled
// uploads; its own header promises a malformed header "degrades to a
// metadata-less blob, never a refusal" (try/catch around the whole call).
// blob.test.ts's local `exifJpeg()` proves the HAPPY path once, inline, for
// one test — this module is the adversary side of that same shape, factored
// out so exif-adversarial.test.ts can throw a whole family of malformed
// inputs at the parser without re-deriving TIFF offsets by hand each time.
// blob.test.ts is untouched; nothing here is imported by it.

const TIFF_ENTRY_SIZE = 12;

interface ExifJpegOptions {
  /** The 2-byte marker the TIFF header opens with. "II" (little-endian) is
   *  what every entry below is actually WRITTEN as; overriding it to anything
   *  else (not "II" or "MM") makes the parser misread every offset and count
   *  that follows as big-endian garbage — the closest analogue this format
   *  has to a "bad magic number", since parseJpegExif never validates the
   *  0x2a magic word itself, only this marker. */
  byteOrderMarker?: string;
  /** What the TIFF header's own offset field claims IFD0 lives at. Real IFD0
   *  is always laid out at byte 8; overriding this only changes what the
   *  parser is TOLD, letting a fixture point it off into the void without
   *  needing a physically enormous buffer. */
  ifd0HeaderOffset?: number;
  /** IFD0's own declared entry count. Real IFD0 here has exactly one entry
   *  (the pointer to the Exif sub-IFD); overriding this to something the
   *  buffer cannot actually back exercises the entry-count-overflow guard. */
  ifd0EntryCount?: number;
  /** ASCII DateTimeOriginal value (include the trailing NUL), or `null` to
   *  omit the tag from the Exif sub-IFD entirely. */
  dateTimeOriginal?: string | null;
  /** Cuts the TIFF body to this many bytes before it is wrapped in the JPEG
   *  APP1 segment — simulates a spool that stopped mid-write. */
  truncateTiffTo?: number;
}

/**
 * One TIFF body — byte-order header, IFD0 with a single Exif-sub-IFD pointer,
 * and an Exif sub-IFD with (at most) one DateTimeOriginal entry — wrapped in
 * a minimal JPEG's SOI/APP1/EOI. General enough that every adversarial
 * builder below is one option away from the well-formed shape.
 *
 * The buffer is ALWAYS allocated at the size the well-formed layout needs
 * (`ifd0HeaderOffset`/`ifd0EntryCount` only change what is declared, never
 * where bytes are actually written), so no option here can produce a
 * write-out-of-bounds in the BUILDER — every corruption this module produces
 * is a lie told to the reader, not a malformed writer.
 */
function buildExifJpeg(options: ExifJpegOptions = {}): Buffer {
  const {
    byteOrderMarker = "II",
    ifd0HeaderOffset,
    ifd0EntryCount,
    dateTimeOriginal = "2024:06:01 10:30:00\0",
    truncateTiffTo,
  } = options;

  const ifd0At = 8;
  const exifIfdAt = ifd0At + 2 + TIFF_ENTRY_SIZE + 4;
  const dataAt = exifIfdAt + 2 + TIFF_ENTRY_SIZE + 4;
  const hasDto = dateTimeOriginal !== null;
  const dto = dateTimeOriginal ?? "";
  const dtoAt = dataAt;

  const tiff = Buffer.alloc(dtoAt + dto.length);
  tiff.write(byteOrderMarker.slice(0, 2), 0, "latin1");
  tiff.writeUInt16LE(0x2a, 2);
  tiff.writeUInt32LE(ifd0HeaderOffset ?? ifd0At, 4);

  const entry = (
    at: number,
    tag: number,
    type: number,
    count: number,
    value: number
  ) => {
    tiff.writeUInt16LE(tag, at);
    tiff.writeUInt16LE(type, at + 2);
    tiff.writeUInt32LE(count, at + 4);
    tiff.writeUInt32LE(value, at + 8);
  };

  tiff.writeUInt16LE(ifd0EntryCount ?? 1, ifd0At);
  entry(ifd0At + 2, 0x8769, 4, 1, exifIfdAt); // → Exif sub-IFD

  if (hasDto) {
    tiff.writeUInt16LE(1, exifIfdAt);
    entry(exifIfdAt + 2, 0x9003, 2, dto.length, dtoAt); // DateTimeOriginal
    tiff.write(dto, dtoAt, "latin1");
  } else {
    tiff.writeUInt16LE(0, exifIfdAt);
  }

  const body =
    truncateTiffTo === undefined ? tiff : tiff.subarray(0, truncateTiffTo);
  const exifBody = Buffer.concat([Buffer.from("Exif\0\0", "latin1"), body]);
  const app1 = Buffer.alloc(4);
  app1.writeUInt16BE(0xffe1, 0);
  app1.writeUInt16BE(exifBody.length + 2, 2);
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]), // SOI
    app1,
    exifBody,
    Buffer.from([0xff, 0xd9]), // EOI
  ]);
}

/** A well-formed JPEG carrying only DateTimeOriginal 2024-06-01T10:30:00 — the
 *  control every adversarial variant below is one option away from. */
export function validExifJpeg(): Buffer {
  return buildExifJpeg();
}

/** No APP1/EXIF segment at all — the plainest camera JPEG shape, and the
 *  simplest way `captured_at` can honestly be absent. */
export function noApp1Jpeg(): Buffer {
  return Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
}

/**
 * The APP1 segment is present but the bytes stop 6 bytes into the TIFF body —
 * before even the 8-byte byte-order/offset header finishes. Simulates a spool
 * write that was interrupted (crash, truncated upload) rather than a
 * deliberately hostile payload.
 */
export function truncatedApp1Jpeg(): Buffer {
  return buildExifJpeg({ truncateTiffTo: 6 });
}

/**
 * A byte-order marker that is neither "II" nor "MM". Every offset, count, and
 * tag the parser reads afterward is interpreted in the wrong endianness —
 * this is the closest this format has to a corrupted magic number, since the
 * literal 0x2a magic word is read from the bytes but never checked against
 * anything (see `byteOrderMarker`'s own doc above).
 */
export function badTiffMagicJpeg(): Buffer {
  return buildExifJpeg({ byteOrderMarker: "XX" });
}

/** IFD0's header-declared offset points tens of megabytes past a buffer that
 *  is, in reality, a few dozen bytes long. */
export function ifdOffsetPastEofJpeg(): Buffer {
  return buildExifJpeg({ ifd0HeaderOffset: 50_000_000 });
}

/** IFD0 declares far more entries than the buffer could ever lay out — the
 *  classic fuzzed-entry-count overflow a hostile or bit-flipped file produces. */
export function entryCountOverflowJpeg(): Buffer {
  return buildExifJpeg({ ifd0EntryCount: 0xffff });
}

/**
 * DateTimeOriginal reads the epoch, `1970:01:01 00:00:00` — a real value a
 * camera with a dead clock/battery actually writes, not evidence of a missing
 * tag. `captured_at` must come back as that honest (wrong) instant, not be
 * swallowed into `undefined` the way a genuinely absent tag is.
 */
export function epochZeroDateTimeJpeg(): Buffer {
  return buildExifJpeg({ dateTimeOriginal: "1970:01:01 00:00:00\0" });
}
