import * as Crypto from 'expo-crypto';

import type { ReplicaDigest, ReplicaIdFactory } from '@centraid/client/replica/native';

/**
 * Hex SHA-256 for replica storage keys and intent payload hashes. React
 * Native's Hermes runtime has no `crypto.subtle`, so `@centraid/client`'s
 * helpers accept these injected implementations instead of their web defaults.
 *
 * `digestStringAsync` defaults to UTF-8 input and hex output, matching
 * `webCryptoDigest` byte for byte — intent idempotency (`intentId` +
 * `payloadHash`) depends on that identity holding across a device swap.
 */
export const nativeReplicaDigest: ReplicaDigest = (input) =>
  Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, input);

/** Hermes has no `crypto.randomUUID`; expo-crypto provides a v4 UUID. */
export const nativeReplicaIdFactory: ReplicaIdFactory = () => Crypto.randomUUID();
