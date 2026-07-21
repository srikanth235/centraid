import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import {
  deriveDataKey,
  openManifest,
  openWalSegment,
  sealManifest,
  sealWalSegment,
  type Keyring,
  type ManifestEntry,
  type ManifestPublic,
  type WalSegmentAddress,
} from './index.ts';

interface GoldenFixture {
  wal: {
    masterKeyHex: string;
    dataKeyHex: string;
    vaultId: string;
    address: WalSegmentAddress;
    plainBase64: string;
    sealedBase64: string;
  };
  snapshot: {
    masterKeyHex: string;
    vaultId: string;
    publicEnvelope: ManifestPublic;
    entries: ManifestEntry[];
    storedBase64: string;
    manifestHash: string;
  };
}

const fixture = JSON.parse(
  readFileSync(
    new URL('../../tunnel/data-plane/fixtures/format-golden.json', import.meta.url),
    'utf8',
  ),
) as GoldenFixture;

test('authenticated WAL golden is byte-identical across Node and Rust', () => {
  const key = Buffer.from(fixture.wal.dataKeyHex, 'hex');
  const plain = Buffer.from(fixture.wal.plainBase64, 'base64');
  const sealed = Buffer.from(fixture.wal.sealedBase64, 'base64');
  expect(
    Buffer.from(openWalSegment(key, fixture.wal.vaultId, fixture.wal.address, sealed)),
  ).toEqual(plain);
  expect(Buffer.from(sealWalSegment(key, fixture.wal.vaultId, fixture.wal.address, plain))).toEqual(
    sealed,
  );
  expect(
    Buffer.from(
      deriveDataKey(Buffer.from(fixture.wal.masterKeyHex, 'hex'), fixture.wal.vaultId),
    ).toString('hex'),
  ).toBe(fixture.wal.dataKeyHex);
});

test('centraid-snapshot/2 golden is byte-identical across Node and Rust', () => {
  const masterKey = Buffer.from(fixture.snapshot.masterKeyHex, 'hex');
  const keyring: Keyring = {
    version: 1,
    active: fixture.snapshot.publicEnvelope.keyEpoch,
    epochs: [
      {
        epoch: fixture.snapshot.publicEnvelope.keyEpoch,
        key: masterKey.toString('base64'),
        createdAt: '2026-07-18T00:00:00.000Z',
      },
    ],
  };
  const stored = Buffer.from(fixture.snapshot.storedBase64, 'base64');
  expect(
    openManifest(stored, keyring, fixture.snapshot.vaultId, fixture.snapshot.manifestHash).entries,
  ).toEqual(fixture.snapshot.entries);
  const publicEnvelope = fixture.snapshot.publicEnvelope;
  const resealed = sealManifest({
    keyring,
    vaultId: fixture.snapshot.vaultId,
    keyEpoch: publicEnvelope.keyEpoch,
    generation: publicEnvelope.generation,
    prevManifestHash: publicEnvelope.prevManifestHash,
    chunkIndex: publicEnvelope.chunkIndex,
    appMeta: publicEnvelope.appMeta,
    entries: fixture.snapshot.entries,
    createdAt: publicEnvelope.createdAt,
  });
  expect(Buffer.from(resealed.bytes)).toEqual(stored);
  expect(resealed.manifestHash).toBe(fixture.snapshot.manifestHash);
});
