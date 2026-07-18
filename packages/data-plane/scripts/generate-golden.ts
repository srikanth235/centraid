import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deriveDataKey, type Keyring } from '../../backup/src/crypto.ts';
import { sealManifest } from '../../backup/src/manifest.ts';
import { sealWalSegment, type WalSegmentAddress } from '../../backup/src/wal-format.ts';
import {
  encodeHeader,
  encodeTrailer,
  sealDirectory,
  sealStoredFrame,
} from '../../vault/src/blob/seal-frames.ts';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const key = Buffer.from(Array.from({ length: 32 }, (_, index) => index));
const plain = Buffer.from('CBSF v2 cross-language golden bytes span several frames.');
const frameSize = 13;
const sha = createHash('sha256').update(plain).digest('hex');
const chunks = Array.from({ length: Math.ceil(plain.length / frameSize) }, (_, index) =>
  plain.subarray(index * frameSize, Math.min(plain.length, (index + 1) * frameSize)),
);
const frames = chunks.map((chunk, index) => sealStoredFrame(key, sha, index, chunks.length, chunk));
const directory = sealDirectory(
  key,
  sha,
  chunks.length,
  frameSize,
  plain.length,
  frames.map((frame) => frame.length),
);
const cbsf = Buffer.concat([
  encodeHeader(sha),
  ...frames,
  directory,
  encodeTrailer(directory.length, chunks.length),
]);

const masterKey = Buffer.from(Array.from({ length: 32 }, (_, index) => 255 - index));
const vaultId = '00000000-0000-7000-8000-000000000456';
const dataKey = deriveDataKey(masterKey, vaultId);
const walPlain = Buffer.from('authenticated WAL bytes from Node!!');
const walAddress: WalSegmentAddress = {
  db: 'vault',
  generation: '0123456789abcdef0123456789abcdef',
  group: 7,
  startOffset: 32,
  endOffset: 32 + walPlain.length,
  tickMs: 1_721_280_000_456,
};
const walSealed = sealWalSegment(dataKey, vaultId, walAddress, walPlain);

const keyring: Keyring = {
  version: 1,
  active: 1,
  epochs: [{ epoch: 1, key: masterKey.toString('base64'), createdAt: '2026-07-18T00:00:00.000Z' }],
};
const chunkId = createHash('sha256').update('golden chunk').digest('hex');
const entries = [
  {
    path: 'vault.db',
    kind: 'db' as const,
    size: 12,
    mtimeMs: 1_721_280_000_000,
    chunks: [chunkId],
    sha256: chunkId,
    walGeneration: walAddress.generation,
    baseTickMs: walAddress.tickMs,
  },
];
const manifest = sealManifest({
  keyring,
  vaultId,
  keyEpoch: 1,
  generation: 3,
  prevManifestHash: null,
  chunkIndex: [{ id: chunkId, size: 12 }],
  appMeta: { source: 'node-golden', version: '456' },
  entries,
  createdAt: '2026-07-18T00:00:00.000Z',
});
const { sealedPayload: _sealedPayload, ...publicEnvelope } = manifest.manifest;

const fixture = {
  schema: 'centraid-cross-language-golden/1',
  cbsf: {
    keyHex: key.toString('hex'),
    plainBase64: plain.toString('base64'),
    frameSize,
    sealedBase64: cbsf.toString('base64'),
  },
  wal: {
    masterKeyHex: masterKey.toString('hex'),
    dataKeyHex: Buffer.from(dataKey).toString('hex'),
    vaultId,
    address: walAddress,
    plainBase64: walPlain.toString('base64'),
    sealedBase64: Buffer.from(walSealed).toString('base64'),
  },
  snapshot: {
    masterKeyHex: masterKey.toString('hex'),
    vaultId,
    publicEnvelope,
    payload: { entries },
    entries,
    storedBase64: Buffer.from(manifest.bytes).toString('base64'),
    manifestHash: manifest.manifestHash,
  },
};
await fs.mkdir(path.join(root, 'fixtures'), { recursive: true });
await fs.writeFile(
  path.join(root, 'fixtures', 'format-golden.json'),
  `${JSON.stringify(fixture, null, 2)}\n`,
);
