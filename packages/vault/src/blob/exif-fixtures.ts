// Adversarial EXIF/JPEG builders (#721): the malformed inputs proving
// `extractBlobMeta` degrades to a metadata-less blob, never a refusal.

const TIFF_ENTRY_SIZE = 12;

interface ExifJpegOptions {
  /** Entries are always WRITTEN little-endian; anything but "II"/"MM" is this
   *  format's nearest thing to bad magic (the 0x2a word is never checked). */
  byteOrderMarker?: string;
  /** What the header CLAIMS, never where bytes go: IFD0 stays at byte 8. */
  ifd0HeaderOffset?: number;
  ifd0EntryCount?: number;
  /** Include the trailing NUL; `null` omits the tag. */
  dateTimeOriginal?: string | null;
  truncateTiffTo?: number;
}

/**
 * Always allocated at the size the WELL-FORMED layout needs, so no option can
 * write out of bounds here: every corruption is a lie told to the reader.
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

/** The control every variant below is one option away from. */
export function validExifJpeg(): Buffer {
  return buildExifJpeg();
}

export function noApp1Jpeg(): Buffer {
  return Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
}

/** Bytes stop before the 8-byte TIFF header finishes. */
export function truncatedApp1Jpeg(): Buffer {
  return buildExifJpeg({ truncateTiffTo: 6 });
}

/** Every later offset and count is read in the wrong endianness. */
export function badTiffMagicJpeg(): Buffer {
  return buildExifJpeg({ byteOrderMarker: "XX" });
}

export function ifdOffsetPastEofJpeg(): Buffer {
  return buildExifJpeg({ ifd0HeaderOffset: 50_000_000 });
}

export function entryCountOverflowJpeg(): Buffer {
  return buildExifJpeg({ ifd0EntryCount: 0xffff });
}

/**
 * A dead-clock camera really writes the epoch: `captured_at` must come back as
 * that honest wrong instant, never `undefined` as an absent tag does.
 */
export function epochZeroDateTimeJpeg(): Buffer {
  return buildExifJpeg({ dateTimeOriginal: "1970:01:01 00:00:00\0" });
}
