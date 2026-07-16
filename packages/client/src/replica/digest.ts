/**
 * The one hash seam the replica is written over. React Native's Hermes runtime
 * ships no `crypto.subtle` (and no `crypto.randomUUID`), so every module that
 * needs a digest takes it as an optional parameter defaulting to WebCrypto.
 * Native hosts inject an `expo-crypto` implementation instead of polyfilling a
 * global — a polyfill would also drag DOM globals into `./native.js`.
 */

/** Hex SHA-256 of `input`. Platforms without WebCrypto (RN Hermes) inject their own. */
export type ReplicaDigest = (input: string) => Promise<string>;

/** Opaque unique intent ids. Hermes has no `crypto.randomUUID`. */
export type ReplicaIdFactory = () => string;

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export const webCryptoDigest: ReplicaDigest = async (input) =>
  hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input)));

export const webCryptoIdFactory: ReplicaIdFactory = () => crypto.randomUUID();
