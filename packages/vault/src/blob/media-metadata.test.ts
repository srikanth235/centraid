import { describe, expect, test } from 'vitest';
import { extractBlobMeta } from './pipeline.js';
import {
  parseId3Metadata,
  parseIsoBmffMetadata,
  parseMediaMetadata,
  parseVorbisMetadata,
  parseWebmMetadata,
} from './media-metadata.js';

function box(type: string, ...payloads: Buffer[]): Buffer {
  const payload = Buffer.concat(payloads);
  const header = Buffer.alloc(8);
  header.writeUInt32BE(payload.length + 8, 0);
  header.write(type, 4, 4, 'latin1');
  return Buffer.concat([header, payload]);
}

function mp4Fixture(): Buffer {
  const ftyp = Buffer.concat([Buffer.from('isom'), Buffer.alloc(12)]);
  const mvhd = Buffer.alloc(100);
  const captured = Math.floor(Date.UTC(2024, 0, 2, 3, 4, 5) / 1000) + 2_082_844_800;
  mvhd.writeUInt32BE(captured, 4);
  mvhd.writeUInt32BE(1000, 12);
  mvhd.writeUInt32BE(6500, 16);
  const tkhd = Buffer.alloc(84);
  tkhd.writeUInt32BE(1920 * 65_536, tkhd.length - 8);
  tkhd.writeUInt32BE(1080 * 65_536, tkhd.length - 4);
  const stsd = Buffer.alloc(16);
  stsd.writeUInt32BE(1, 4);
  stsd.writeUInt32BE(8, 8);
  stsd.write('avc1', 12, 4, 'latin1');
  const trak = box(
    'trak',
    box('tkhd', tkhd),
    box('mdia', box('minf', box('stbl', box('stsd', stsd)))),
  );
  return Buffer.concat([box('ftyp', ftyp), box('moov', box('mvhd', mvhd), trak)]);
}

function ebmlSize(size: number): Buffer {
  if (size <= 126) return Buffer.from([0x80 | size]);
  return Buffer.from([0x40 | (size >> 8), size & 0xff]);
}

function element(id: number[], payload: Buffer): Buffer {
  return Buffer.concat([Buffer.from(id), ebmlSize(payload.length), payload]);
}

function uint(value: number, bytes = 1): Buffer {
  const out = Buffer.alloc(bytes);
  out.writeUIntBE(value, 0, bytes);
  return out;
}

function webmFixture(): Buffer {
  const duration = Buffer.alloc(8);
  duration.writeDoubleBE(12_500);
  const info = element(
    [0x15, 0x49, 0xa9, 0x66],
    Buffer.concat([
      element([0x2a, 0xd7, 0xb1], uint(1_000_000, 3)),
      element([0x44, 0x89], duration),
    ]),
  );
  const video = element(
    [0xe0],
    Buffer.concat([element([0xb0], uint(1280, 2)), element([0xba], uint(720, 2))]),
  );
  const track = element(
    [0xae],
    Buffer.concat([element([0x83], uint(1)), element([0x86], Buffer.from('V_VP9')), video]),
  );
  const tracks = element([0x16, 0x54, 0xae, 0x6b], track);
  const segment = element([0x18, 0x53, 0x80, 0x67], Buffer.concat([info, tracks]));
  return Buffer.concat([element([0x1a, 0x45, 0xdf, 0xa3], Buffer.alloc(0)), segment]);
}

function id3Frame(id: string, value: string): Buffer {
  const body = Buffer.concat([Buffer.from([3]), Buffer.from(value)]);
  const header = Buffer.alloc(10);
  header.write(id, 0, 4, 'latin1');
  header.writeUInt32BE(body.length, 4);
  return Buffer.concat([header, body]);
}

function id3Fixture(): Buffer {
  const frames = Buffer.concat([id3Frame('TIT2', 'Night train'), id3Frame('TPE1', 'Mira')]);
  const header = Buffer.from([0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 0, frames.length]);
  return Buffer.concat([header, frames, Buffer.from('audio')]);
}

function vorbisFixture(): Buffer {
  const vendor = Buffer.from('centraid');
  const comments = ['TITLE=Morning field', 'ARTIST=Arun'].map((value) => {
    const bytes = Buffer.from(value);
    const size = Buffer.alloc(4);
    size.writeUInt32LE(bytes.length);
    return Buffer.concat([size, bytes]);
  });
  const vendorSize = Buffer.alloc(4);
  vendorSize.writeUInt32LE(vendor.length);
  const count = Buffer.alloc(4);
  count.writeUInt32LE(comments.length);
  return Buffer.concat([
    Buffer.from('OggS....\x03vorbis', 'latin1'),
    vendorSize,
    vendor,
    count,
    ...comments,
  ]);
}

describe('bounded media metadata parsers', () => {
  test('ISO-BMFF reads mvhd/tkhd/stsd without decoding media', () => {
    expect(parseIsoBmffMetadata(mp4Fixture())).toEqual({
      duration_s: 6.5,
      width: 1920,
      height: 1080,
      codec: 'avc1',
      captured_at: '2024-01-02T03:04:05.000Z',
    });
  });

  test('WebM reads Info duration and video track metadata', () => {
    expect(parseWebmMetadata(webmFixture())).toMatchObject({
      duration_s: 12.5,
      width: 1280,
      height: 720,
      codec: 'V_VP9',
    });
  });

  test('ID3 and Vorbis comments expose title/artist as metadata', () => {
    expect(parseId3Metadata(id3Fixture())).toMatchObject({
      codec: 'mp3',
      title: 'Night train',
      artist: 'Mira',
    });
    expect(parseVorbisMetadata(vorbisFixture())).toMatchObject({
      codec: 'vorbis',
      title: 'Morning field',
      artist: 'Arun',
    });
  });

  test('pipeline integrates parsers and malformed containers degrade honestly', () => {
    expect(extractBlobMeta(mp4Fixture(), 'video/mp4')).toMatchObject({
      duration_s: 6.5,
      width: 1920,
      height: 1080,
    });
    expect(extractBlobMeta(id3Fixture(), 'audio/mpeg')).toMatchObject({
      title: 'Night train',
      artist: 'Mira',
    });
    expect(parseMediaMetadata(Buffer.from('not a container'), 'video/mp4')).toEqual({});
    expect(parseIsoBmffMetadata(Buffer.from('broken'))).toEqual({});
  });
});
