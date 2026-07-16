// Intent idempotency pairs `intentId` + `payloadHash` at the gateway: a web and
// a native client that hash the same payload differently would collide as a
// ReplicaProtocolError after a device swap. This pins the canonical form and
// the exact digest, and proves an independently implemented digest (the shape
// `expo-crypto` fills on Hermes) reproduces it byte for byte.
import { createHash } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { ReplicaDigest } from './digest.js';
import { canonicalJson, intentPayloadHash } from './payload-hash.js';

const payload = {
  appId: 'photos',
  action: 'photos.favorite',
  input: { assetId: 'asset-1', favorite: true },
};

const CANONICAL =
  '{"action":"photos.favorite","appId":"photos","input":{"assetId":"asset-1","favorite":true}}';
const EXPECTED_HASH = '9fb4ce111fbf05254e7437936d9e5082d6888dd4112fe38c8254c6d1beff844f';

/** Stand-in for `expo-crypto`'s `digestStringAsync(SHA256, input)` — hex over UTF-8. */
const nodeDigest: ReplicaDigest = (input) =>
  Promise.resolve(createHash('sha256').update(input, 'utf8').digest('hex'));

describe('intent payload hash identity across platforms', () => {
  test('canonical JSON sorts keys and is the exact hashed string', () => {
    expect(
      canonicalJson({ action: payload.action, appId: payload.appId, input: payload.input }),
    ).toBe(CANONICAL);
  });

  test('the WebCrypto default matches the pinned fixture hash', async () => {
    expect(await intentPayloadHash(payload)).toBe(EXPECTED_HASH);
  });

  test('an injected non-WebCrypto digest produces the identical hash', async () => {
    expect(await intentPayloadHash(payload, nodeDigest)).toBe(EXPECTED_HASH);
    expect(await intentPayloadHash(payload, nodeDigest)).toBe(await intentPayloadHash(payload));
  });

  test('key insertion order does not change the hash across implementations', async () => {
    const reordered = {
      appId: 'photos',
      action: 'photos.favorite',
      input: { favorite: true, assetId: 'asset-1' },
    };
    expect(await intentPayloadHash(reordered, nodeDigest)).toBe(EXPECTED_HASH);
  });
});
