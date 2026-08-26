// Proves location leaves the BYTES (#816): the fixture carries a real fix (Exif GPS, XMP, IPTC)
// and assertions use the independent parser below — "digits gone from bytes", not a render claim.

import { describe, expect, it } from "vitest";

import { isJpeg, stripJpegLocation } from "./exif-location-strip";

/** NUL terminating tags below — escaped so no repo file carries a literal zero byte. */
const NUL = "\u0000";

const MARKER = 0xff;
const SOI = [MARKER, 0xd8];
const EOI = [MARKER, 0xd9];

/** Big-endian TIFF words under `MM`. */
const be16 = (value: number): number[] => [(value >> 8) & 0xff, value & 0xff];
const be32 = (value: number): number[] => [
  (value >>> 24) & 0xff,
  (value >>> 16) & 0xff,
  (value >>> 8) & 0xff,
  value & 0xff,
];
const le16 = (value: number): number[] => be16(value).reverse();
const le32 = (value: number): number[] => be32(value).reverse();
const ascii = (text: string): number[] =>
  [...text].map((character) => character.charCodeAt(0));

interface ByteOrder {
  mark: number[];
  u16: (value: number) => number[];
  u32: (value: number) => number[];
}

const BIG: ByteOrder = { mark: ascii("MM"), u16: be16, u32: be32 };
const LITTLE: ByteOrder = { mark: ascii("II"), u16: le16, u32: le32 };

/** One 12-byte IFD entry; `value` padded to its four bytes. */
function entry(
  order: ByteOrder,
  tag: number,
  type: number,
  count: number,
  value: number[]
): number[] {
  const padded = [...value, 0, 0, 0, 0].slice(0, 4);
  return [
    ...order.u16(tag),
    ...order.u16(type),
    ...order.u32(count),
    ...padded,
  ];
}

/** GPS coordinate as EXIF's three rationals: degrees, minutes, seconds. */
function rationals(order: ByteOrder, parts: [number, number][]): number[] {
  return parts.flatMap(([numerator, denominator]) => [
    ...order.u32(numerator),
    ...order.u32(denominator),
  ]);
}

const CAPTURED = `2026:08:17 09:41:00${NUL}`;
/** 37° 26' 30.84" N — the digits the strip must make disappear. */
const LATITUDE: [number, number][] = [
  [37, 1],
  [26, 1],
  [3084, 100],
];
/** 122° 8' 34.8" W. */
const LONGITUDE: [number, number][] = [
  [122, 1],
  [8, 1],
  [348, 10],
];

// Fixed TIFF layout: every pointer is a named number.
const IFD0_AT = 8;
const IFD0_ENTRIES = 3;
const CAPTURED_AT = IFD0_AT + 2 + IFD0_ENTRIES * 12 + 4; // 50
const GPS_IFD_AT = CAPTURED_AT + CAPTURED.length; // 70
const GPS_ENTRIES = 4;
const GPS_DATA_AT = GPS_IFD_AT + 2 + GPS_ENTRIES * 12 + 4; // 124
const LONGITUDE_AT = GPS_DATA_AT + 24;

/** TIFF block with an orientation, a capture time and a real GPS directory. */
function tiff(order: ByteOrder): number[] {
  return [
    ...order.mark,
    ...order.u16(42),
    ...order.u32(IFD0_AT),
    ...order.u16(IFD0_ENTRIES),
    // Orientation 6 — the tag the walker must leave alone.
    ...entry(order, 0x0112, 3, 1, order.u16(6)),
    ...entry(order, 0x0132, 2, CAPTURED.length, order.u32(CAPTURED_AT)),
    ...entry(order, 0x8825, 4, 1, order.u32(GPS_IFD_AT)),
    ...order.u32(0),
    ...ascii(CAPTURED),
    ...order.u16(GPS_ENTRIES),
    ...entry(order, 0x0001, 2, 2, ascii(`N${NUL}`)),
    ...entry(order, 0x0002, 5, 3, order.u32(GPS_DATA_AT)),
    ...entry(order, 0x0003, 2, 2, ascii(`W${NUL}`)),
    ...entry(order, 0x0004, 5, 3, order.u32(LONGITUDE_AT)),
    ...order.u32(0),
    ...rationals(order, LATITUDE),
    ...rationals(order, LONGITUDE),
  ];
}

/** Any APP segment + the two-byte length JPEG prepends. */
function segment(marker: number, payload: number[]): number[] {
  return [MARKER, marker, ...be16(payload.length + 2), ...payload];
}

const XMP_PACKET = ascii(
  `http://ns.adobe.com/xap/1.0/${NUL}<x:xmpmeta><rdf:Description exif:GPSLatitude="37,26.514000N"/></x:xmpmeta>`
);
const IPTC_BLOCK = [
  ...ascii(`Photoshop 3.0${NUL}`),
  ...ascii("8BIM"),
  ...be16(0x0404),
  0,
  0,
  ...be16(12),
  ...ascii("Menlo Park  "),
];

/** The compressed image — never metadata, never touched. */
const SCAN = [
  ...segment(0xda, [0x00, 0x03, 0x01, 0x00, 0x3f, 0x00]),
  0x12,
  0x34,
  0x56,
  0x78,
  ...EOI,
];

/** A photograph carrying a fix three different ways. */
function photograph(order: ByteOrder = BIG): Uint8Array {
  return new Uint8Array([
    ...SOI,
    ...segment(0xe1, [...ascii(`Exif${NUL}${NUL}`), ...tiff(order)]),
    ...segment(0xe1, XMP_PACKET),
    ...segment(0xed, IPTC_BLOCK),
    ...SCAN,
  ]);
}

/** A photograph that never knew where it was. */
function unlocatedPhotograph(): Uint8Array {
  const order = BIG;
  return new Uint8Array([
    ...SOI,
    ...segment(0xe1, [
      ...ascii(`Exif${NUL}${NUL}`),
      ...order.mark,
      ...order.u16(42),
      ...order.u32(8),
      ...order.u16(1),
      ...entry(order, 0x0112, 3, 1, order.u16(6)),
      ...order.u32(0),
    ]),
    ...SCAN,
  ]);
}

// ── Independent reader: against the format, not the module under test ──

interface ExifRead {
  orientation?: number;
  captured?: string;
  gpsEntries: number;
}

function readExif(bytes: Uint8Array): ExifRead | null {
  const header = ascii(`Exif${NUL}${NUL}`);
  let at = 2;
  while (at + 4 < bytes.length) {
    if (bytes[at] !== MARKER) return null;
    const marker = bytes[at + 1]!;
    if (marker === 0xda) return null;
    const length = (bytes[at + 2]! << 8) | bytes[at + 3]!;
    const payload = at + 4;
    const isExif = header.every((byte, i) => bytes[payload + i] === byte);
    if (marker === 0xe1 && isExif) {
      return readTiff(bytes, payload + header.length);
    }
    at += 2 + length;
  }
  return null;
}

function readTiff(bytes: Uint8Array, start: number): ExifRead {
  const big = bytes[start] === 0x4d;
  const u16 = (i: number): number =>
    big ? (bytes[i]! << 8) | bytes[i + 1]! : (bytes[i + 1]! << 8) | bytes[i]!;
  const u32 = (i: number): number =>
    big
      ? ((bytes[i]! << 24) |
          (bytes[i + 1]! << 16) |
          (bytes[i + 2]! << 8) |
          bytes[i + 3]!) >>>
        0
      : ((bytes[i + 3]! << 24) |
          (bytes[i + 2]! << 16) |
          (bytes[i + 1]! << 8) |
          bytes[i]!) >>>
        0;
  const ifd = start + u32(start + 4);
  const count = u16(ifd);
  const read: ExifRead = { gpsEntries: 0 };
  for (let k = 0; k < count; k += 1) {
    const at = ifd + 2 + k * 12;
    const tag = u16(at);
    if (tag === 0x0112) read.orientation = u16(at + 8);
    if (tag === 0x0132) {
      const text = start + u32(at + 8);
      read.captured = String.fromCharCode(
        ...bytes.subarray(text, text + u32(at + 4))
      );
    }
    if (tag === 0x8825) read.gpsEntries = u16(start + u32(at + 8));
  }
  return read;
}

/** Does `haystack` contain this exact run of bytes anywhere? */
function contains(haystack: Uint8Array, needle: number[]): boolean {
  return haystack.some((_, index) =>
    needle.every((byte, offset) => haystack[index + offset] === byte)
  );
}

describe("the fixture really is a located photograph", () => {
  it("carries an orientation, a capture time and four GPS entries", () => {
    expect(readExif(photograph())).toStrictEqual({
      captured: CAPTURED,
      gpsEntries: GPS_ENTRIES,
      orientation: 6,
    });
    expect(contains(photograph(), rationals(BIG, LATITUDE))).toBe(true);
  });
});

describe("what a shared copy no longer says", () => {
  it("has an empty GPS directory and none of the digits left in it", () => {
    const stripped = stripJpegLocation(photograph());
    expect(readExif(stripped!.bytes)?.gpsEntries).toBe(0);
    expect(contains(stripped!.bytes, rationals(BIG, LATITUDE))).toBe(false);
    expect(contains(stripped!.bytes, rationals(BIG, LONGITUDE))).toBe(false);
    // The reference letters go too — "N"/"W" are half a coordinate.
    expect(contains(stripped!.bytes, ascii(`N${NUL}`))).toBe(false);
  });

  it("carries neither the XMP packet nor the IPTC town", () => {
    const stripped = stripJpegLocation(photograph());
    expect(contains(stripped!.bytes, ascii("GPSLatitude"))).toBe(false);
    expect(contains(stripped!.bytes, ascii("Menlo Park"))).toBe(false);
  });

  it("names everything it took out", () => {
    expect(stripJpegLocation(photograph())!.removed).toStrictEqual([
      "exif-gps",
      "xmp",
      "iptc",
    ]);
  });

  it("still opens the right way up, at the time it was taken", () => {
    const stripped = stripJpegLocation(photograph());
    expect(readExif(stripped!.bytes)).toStrictEqual({
      captured: CAPTURED,
      gpsEntries: 0,
      orientation: 6,
    });
  });

  it("leaves the photograph itself byte for byte", () => {
    const stripped = stripJpegLocation(photograph())!.bytes;
    expect([...stripped.subarray(stripped.length - SCAN.length)]).toStrictEqual(
      SCAN
    );
  });

  it("reads a little-endian file as readily as a big-endian one", () => {
    const stripped = stripJpegLocation(photograph(LITTLE));
    expect(readExif(stripped!.bytes)?.gpsEntries).toBe(0);
    expect(contains(stripped!.bytes, rationals(LITTLE, LATITUDE))).toBe(false);
    expect(readExif(stripped!.bytes)?.orientation).toBe(6);
  });
});

describe("bytes with nothing to remove", () => {
  it("returns a photograph that never carried a location unchanged", () => {
    const original = unlocatedPhotograph();
    const stripped = stripJpegLocation(original);
    expect(stripped?.removed).toStrictEqual([]);
    expect([...stripped!.bytes]).toStrictEqual([...original]);
  });

  it("refuses a container it cannot walk, rather than passing it through", () => {
    // Not-JPEG container: the null makes `photo-share.ts` re-encode or refuse rather than ship the fix.
    expect(
      stripJpegLocation(new Uint8Array([0, 0, 0, 24, 102, 116]))
    ).toBeNull();
    expect(isJpeg(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d]))).toBe(false);
  });

  it("does not throw on a truncated file", () => {
    const cut = photograph().subarray(0, 40);
    expect(stripJpegLocation(cut)?.removed).toStrictEqual([]);
  });
});
