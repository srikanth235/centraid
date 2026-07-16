// Per-blob content-key registry for edge-sealed CAS objects (#414). A random
// content key encrypts one CBSF object; the registry wraps it under the vault
// DEK and grants it independently to paired devices. Revoking a device drops
// its grants without rotating/re-uploading every blob.

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { VaultBlobAuthorizationError } from '../errors.js';
import { nowIso, uuidv7 } from '../ids.js';
import { assertSha } from './store.js';

const NONCE_BYTES = 12;
const KEY_BYTES = 32;

function seal(key: Buffer, aad: string, plain: Buffer): { nonce: Buffer; wrapped: Buffer } {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(aad));
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return { nonce, wrapped: Buffer.concat([body, cipher.getAuthTag()]) };
}

function open(key: Buffer, aad: string, nonce: Buffer, wrapped: Buffer): Buffer {
  const tag = wrapped.subarray(wrapped.length - 16);
  const body = wrapped.subarray(0, wrapped.length - 16);
  const decipher = createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]);
}

export interface DeviceWrappedContentKey {
  algorithm: 'AES-256-GCM';
  /** Per-device wrapping epoch; rotates on any device revocation. */
  keyEpoch: number;
  /** Vault-root wrapping epoch for the stable per-blob content key. */
  contentKeyEpoch: number;
  wrapSaltBase64: string;
  nonceBase64: string;
  wrappedKeyBase64: string;
  aad: string;
}

export class BlobContentKeyRegistry {
  private wrappingKey: Buffer;

  constructor(
    private readonly db: DatabaseSync,
    wrappingKey: Buffer,
  ) {
    if (wrappingKey.length !== KEY_BYTES) throw new Error('blob key wrapping key must be 32 bytes');
    this.wrappingKey = Buffer.from(wrappingKey);
  }

  /** Resolve only a live vault-enrolled device, by row id or authenticated key. */
  resolvePairedDevice(identity: string): string {
    const row = this.db
      .prepare(
        `SELECT device_id, trust FROM consent_device
          WHERE device_id = ? OR public_key = ?
          LIMIT 1`,
      )
      .get(identity, identity) as { device_id: string; trust: string } | undefined;
    if (!row || row.trust === 'revoked') {
      throw new VaultBlobAuthorizationError(`unknown or revoked paired device ${identity}`);
    }
    return row.device_id;
  }

  /** Mirror an explicitly paired transport identity into the vault key roster. */
  enrollPairedDevice(input: {
    identity: string;
    ownerPartyId: string;
    name: string;
    platform?: string;
    trust: 'full' | 'readonly';
  }): string {
    const existing = this.db
      .prepare('SELECT device_id FROM consent_device WHERE public_key = ?')
      .get(input.identity) as { device_id: string } | undefined;
    if (existing) {
      this.db
        .prepare(
          `UPDATE consent_device SET name = ?, platform = ?, trust = ?
            WHERE device_id = ?`,
        )
        .run(input.name, input.platform ?? null, input.trust, existing.device_id);
      return existing.device_id;
    }
    const deviceId = uuidv7();
    this.db
      .prepare(
        `INSERT INTO consent_device
           (device_id, owner_party_id, name, platform, public_key, trust, enrolled_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        deviceId,
        input.ownerPartyId,
        input.name,
        input.platform ?? null,
        input.identity,
        input.trust,
        nowIso(),
      );
    return deviceId;
  }

  getOrCreate(sha256: string): Buffer {
    const sha = assertSha(sha256);
    const row = this.db
      .prepare('SELECT wrapped_key, wrap_nonce, key_epoch FROM blob_content_key WHERE sha256 = ?')
      .get(sha) as
      | { wrapped_key: Uint8Array; wrap_nonce: Uint8Array; key_epoch: number }
      | undefined;
    if (row) {
      return open(
        this.wrappingKey,
        `blob-key:${sha}:epoch:${row.key_epoch}`,
        Buffer.from(row.wrap_nonce),
        Buffer.from(row.wrapped_key),
      );
    }
    const contentKey = randomBytes(KEY_BYTES);
    const now = nowIso();
    const wrapped = seal(this.wrappingKey, `blob-key:${sha}:epoch:1`, contentKey);
    this.db
      .prepare(
        `INSERT INTO blob_content_key
           (sha256, wrapped_key, wrap_nonce, key_epoch, created_at, updated_at)
         VALUES (?, ?, ?, 1, ?, ?)`,
      )
      .run(sha, wrapped.wrapped, wrapped.nonce, now, now);
    return contentKey;
  }

  grantToDevice(sha256: string, deviceId: string): DeviceWrappedContentKey {
    const sha = assertSha(sha256);
    const resolvedDeviceId = this.resolvePairedDevice(deviceId);
    const device = this.db
      .prepare('SELECT public_key FROM consent_device WHERE device_id = ?')
      .get(resolvedDeviceId) as { public_key: string };
    const contentKey = this.getOrCreate(sha);
    const keyRow = this.db
      .prepare('SELECT key_epoch FROM blob_content_key WHERE sha256 = ?')
      .get(sha) as { key_epoch: number };
    const wrap = this.deviceWrapState(resolvedDeviceId);
    const deviceKey = this.deriveDeviceWrapKey(device.public_key, wrap.salt, wrap.key_epoch);
    const aad =
      `blob-key-grant:${sha}:${resolvedDeviceId}:device-epoch:${wrap.key_epoch}:` +
      `content-epoch:${keyRow.key_epoch}`;
    const wrapped = seal(deviceKey, aad, contentKey);
    this.db
      .prepare(
        `INSERT INTO blob_device_content_key
           (sha256, device_id, wrapped_key, wrap_nonce, device_key_epoch, granted_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (sha256, device_id) DO UPDATE SET
           wrapped_key = excluded.wrapped_key, wrap_nonce = excluded.wrap_nonce,
           device_key_epoch = excluded.device_key_epoch, granted_at = excluded.granted_at`,
      )
      .run(sha, resolvedDeviceId, wrapped.wrapped, wrapped.nonce, wrap.key_epoch, nowIso());
    return {
      algorithm: 'AES-256-GCM',
      keyEpoch: wrap.key_epoch,
      contentKeyEpoch: keyRow.key_epoch,
      wrapSaltBase64: wrap.salt.toString('base64'),
      nonceBase64: wrapped.nonce.toString('base64'),
      wrappedKeyBase64: wrapped.wrapped.toString('base64'),
      aad,
    };
  }

  revokeDevice(deviceId: string): number {
    const row = this.db
      .prepare('SELECT device_id FROM consent_device WHERE device_id = ? OR public_key = ? LIMIT 1')
      .get(deviceId, deviceId) as { device_id: string } | undefined;
    if (!row) return 0;
    const devices = this.db
      .prepare('SELECT device_id, public_key FROM consent_device ORDER BY device_id')
      .all() as { device_id: string; public_key: string }[];
    for (const device of devices) this.deviceWrapState(device.device_id);
    let revoked = 0;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db
        .prepare("UPDATE consent_device SET trust = 'revoked' WHERE device_id = ?")
        .run(row.device_id);
      for (const device of devices) {
        const current = this.deviceWrapState(device.device_id);
        const next = { key_epoch: current.key_epoch + 1, salt: randomBytes(KEY_BYTES) };
        this.db
          .prepare(
            'UPDATE blob_device_wrap_key SET key_epoch = ?, salt = ?, updated_at = ? WHERE device_id = ?',
          )
          .run(next.key_epoch, next.salt, nowIso(), device.device_id);
        if (device.device_id === row.device_id) {
          revoked = Number(
            this.db
              .prepare('DELETE FROM blob_device_content_key WHERE device_id = ?')
              .run(device.device_id).changes,
          );
          continue;
        }
        const grants = this.db
          .prepare('SELECT sha256 FROM blob_device_content_key WHERE device_id = ?')
          .all(device.device_id) as { sha256: string }[];
        const nextDeviceKey = this.deriveDeviceWrapKey(
          device.public_key,
          next.salt,
          next.key_epoch,
        );
        for (const grant of grants) {
          const contentKey = this.getOrCreate(grant.sha256);
          const content = this.db
            .prepare('SELECT key_epoch FROM blob_content_key WHERE sha256 = ?')
            .get(grant.sha256) as { key_epoch: number };
          const aad =
            `blob-key-grant:${grant.sha256}:${device.device_id}:device-epoch:${next.key_epoch}:` +
            `content-epoch:${content.key_epoch}`;
          const wrapped = seal(nextDeviceKey, aad, contentKey);
          this.db
            .prepare(
              `UPDATE blob_device_content_key SET wrapped_key = ?, wrap_nonce = ?,
                 device_key_epoch = ?, granted_at = ? WHERE sha256 = ? AND device_id = ?`,
            )
            .run(
              wrapped.wrapped,
              wrapped.nonce,
              next.key_epoch,
              nowIso(),
              grant.sha256,
              device.device_id,
            );
        }
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return revoked;
  }

  private deviceWrapState(deviceId: string): { key_epoch: number; salt: Buffer } {
    this.db
      .prepare(
        `INSERT INTO blob_device_wrap_key (device_id, key_epoch, salt, updated_at)
         VALUES (?, 1, ?, ?) ON CONFLICT (device_id) DO NOTHING`,
      )
      .run(deviceId, randomBytes(KEY_BYTES), nowIso());
    const row = this.db
      .prepare('SELECT key_epoch, salt FROM blob_device_wrap_key WHERE device_id = ?')
      .get(deviceId) as { key_epoch: number; salt: Uint8Array };
    return { key_epoch: row.key_epoch, salt: Buffer.from(row.salt) };
  }

  private deriveDeviceWrapKey(publicKey: string, salt: Buffer, epoch: number): Buffer {
    return createHash('sha256')
      .update('centraid-device-blob-wrap\0')
      .update(publicKey)
      .update('\0')
      .update(salt)
      .update(String(epoch))
      .digest();
  }

  /** Re-wrap registry rows after a vault wrapping-key rotation; blob bytes stay put. */
  rewrapAll(nextWrappingKey: Buffer): number {
    if (nextWrappingKey.length !== KEY_BYTES) throw new Error('next wrapping key must be 32 bytes');
    const rows = this.db
      .prepare(
        'SELECT sha256, wrapped_key, wrap_nonce, key_epoch FROM blob_content_key ORDER BY sha256',
      )
      .all() as {
      sha256: string;
      wrapped_key: Uint8Array;
      wrap_nonce: Uint8Array;
      key_epoch: number;
    }[];
    const nextKey = Buffer.from(nextWrappingKey);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const row of rows) {
        const contentKey = open(
          this.wrappingKey,
          `blob-key:${row.sha256}:epoch:${row.key_epoch}`,
          Buffer.from(row.wrap_nonce),
          Buffer.from(row.wrapped_key),
        );
        const nextEpoch = row.key_epoch + 1;
        const wrapped = seal(nextKey, `blob-key:${row.sha256}:epoch:${nextEpoch}`, contentKey);
        this.db
          .prepare(
            `UPDATE blob_content_key
                SET wrapped_key = ?, wrap_nonce = ?, key_epoch = ?, updated_at = ?
              WHERE sha256 = ?`,
          )
          .run(wrapped.wrapped, wrapped.nonce, nextEpoch, nowIso(), row.sha256);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    this.wrappingKey = nextKey;
    return rows.length;
  }
}
