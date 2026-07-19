import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import {
  decodeHeader,
  decodeTrailer,
  encodeHeader,
  encodeTrailer,
  openDirectory,
  sealDirectory,
  sealStoredFrame,
  unsealFrame,
} from './blob/seal-frames.ts';

interface GoldenFixture {
  cbsf: { keyHex: string; plainBase64: string; frameSize: number; sealedBase64: string };
  cbsfCompressed: Record<
    'zstd' | 'deflate',
    { algorithm: number; plainBase64: string; sealedBase64: string }
  >;
}

const fixture = JSON.parse(
  readFileSync(new URL('../../data-plane/fixtures/format-golden.json', import.meta.url), 'utf8'),
) as GoldenFixture;

test('CBSF v2 golden is byte-identical across Node and Rust', () => {
  const key = Buffer.from(fixture.cbsf.keyHex, 'hex');
  const expectedPlain = Buffer.from(fixture.cbsf.plainBase64, 'base64');
  const sealed = Buffer.from(fixture.cbsf.sealedBase64, 'base64');
  const sha = decodeHeader(sealed).sha256;
  const trailer = decodeTrailer(sealed.subarray(sealed.length - 13));
  const directoryStart = sealed.length - 13 - trailer.directoryLength;
  const directory = openDirectory(
    key,
    sha,
    trailer.frameCount,
    sealed.subarray(directoryStart, sealed.length - 13),
  );
  const frames = directory.offsets.map((offset, index) =>
    sealed.subarray(offset, offset + directory.sealedLens[index]!),
  );
  expect(
    Buffer.concat(
      frames.map((frame, index) => unsealFrame(key, sha, index, trailer.frameCount, frame)),
    ),
  ).toEqual(expectedPlain);

  const resealedFrames = Array.from(
    { length: Math.ceil(expectedPlain.length / fixture.cbsf.frameSize) },
    (_, index) =>
      sealStoredFrame(
        key,
        sha,
        index,
        trailer.frameCount,
        expectedPlain.subarray(
          index * fixture.cbsf.frameSize,
          Math.min(expectedPlain.length, (index + 1) * fixture.cbsf.frameSize),
        ),
      ),
  );
  const resealedDirectory = sealDirectory(
    key,
    sha,
    trailer.frameCount,
    fixture.cbsf.frameSize,
    expectedPlain.length,
    resealedFrames.map((frame) => frame.length),
  );
  expect(
    Buffer.concat([
      encodeHeader(sha),
      ...resealedFrames,
      resealedDirectory,
      encodeTrailer(resealedDirectory.length, trailer.frameCount),
    ]),
  ).toEqual(sealed);
});

test('CBSF compressed algorithm goldens open in both Node and Rust', () => {
  const key = Buffer.from(fixture.cbsf.keyHex, 'hex');
  for (const [name, vector] of Object.entries(fixture.cbsfCompressed)) {
    const sealed = Buffer.from(vector.sealedBase64, 'base64');
    const sha = decodeHeader(sealed).sha256;
    const trailer = decodeTrailer(sealed.subarray(sealed.length - 13));
    const directoryStart = sealed.length - 13 - trailer.directoryLength;
    const directory = openDirectory(
      key,
      sha,
      trailer.frameCount,
      sealed.subarray(directoryStart, sealed.length - 13),
    );
    const frame = sealed.subarray(
      directory.offsets[0],
      directory.offsets[0]! + directory.sealedLens[0]!,
    );
    expect(unsealFrame(key, sha, 0, 1, frame), name).toEqual(
      Buffer.from(vector.plainBase64, 'base64'),
    );
  }
});
