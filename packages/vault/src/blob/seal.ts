// Remote-tier blob sealing (issue #296 encryption + #367 §C8 streaming):
// AES-256-GCM under the vault DEK, AAD `blob:<sha>`, wire shape
// `nonce | ciphertext | tag`. Split out of custody.ts (which stays the
// custody/replication facade) purely along the crypto seam.

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { Transform } from 'node:stream';

const NONCE_BYTES = 12;
const TAG_BYTES = 16;

/** AAD binding a remote ciphertext to its content address. */
function blobAad(sha: string): Buffer {
  return Buffer.from(`blob:${sha}`, 'utf8');
}

export function sealBlob(key: Buffer, sha: string, plaintext: Buffer): Buffer {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(blobAad(sha));
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([nonce, ct, cipher.getAuthTag()]);
}

/**
 * Streaming twin of `sealBlob` (issue #367 §C8): the same wire shape
 * (`nonce | ciphertext | tag`) produced incrementally so the replication
 * path never holds a large blob's plaintext OR ciphertext whole in memory —
 * AES-GCM supports incremental `update()` calls; the nonce prefixes the
 * first output chunk and the tag is appended once `flush()` runs.
 */
export function sealBlobStream(key: Buffer, sha: string): Transform {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(blobAad(sha));
  let prefixSent = false;
  return new Transform({
    transform(chunk: Buffer, _enc, callback) {
      const out = prefixSent ? [cipher.update(chunk)] : [nonce, cipher.update(chunk)];
      prefixSent = true;
      callback(null, Buffer.concat(out));
    },
    flush(callback) {
      const out = prefixSent ? [cipher.final(), cipher.getAuthTag()] : [nonce, cipher.final(), cipher.getAuthTag()];
      callback(null, Buffer.concat(out));
    },
  });
}

export function unsealBlob(key: Buffer, sha: string, sealed: Buffer): Buffer {
  if (sealed.length < NONCE_BYTES + TAG_BYTES) throw new Error('sealed blob truncated');
  const nonce = sealed.subarray(0, NONCE_BYTES);
  const tag = sealed.subarray(sealed.length - TAG_BYTES);
  const ct = sealed.subarray(NONCE_BYTES, sealed.length - TAG_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAAD(blobAad(sha));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

