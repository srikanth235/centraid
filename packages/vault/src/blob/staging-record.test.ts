import { expect, test } from 'vitest';
import { openVaultDb } from '../db.js';
import { recordKnownStagedBlob } from './staging-record.js';

test('an idempotent completed-session reply preserves metadata learned from plaintext probes', () => {
  const db = openVaultDb();
  try {
    const sha256 = 'a'.repeat(64);
    recordKnownStagedBlob(db.vault, {
      sha256,
      byteSize: 128,
      mediaType: 'application/pdf',
      meta: { text: 'bounded text learned while plaintext was flowing' },
    });
    const replay = recordKnownStagedBlob(db.vault, {
      sha256,
      byteSize: 128,
      mediaType: 'application/pdf',
    });
    expect(replay.meta).toEqual({ text: 'bounded text learned while plaintext was flowing' });
  } finally {
    db.close();
  }
});
