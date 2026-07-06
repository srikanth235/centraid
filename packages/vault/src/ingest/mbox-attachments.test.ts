// The import spine's blob door (issue #296 §3): mbox MIME attachments stage
// into the CAS with a batch hold, publish claims them onto the message, and
// discard releases the hold so the TTL sweep reclaims the bytes.

import { beforeEach, expect, test } from 'vitest';
import { bootstrapVault, type BootstrapResult } from '../bootstrap.js';
import { openVaultDb, type VaultDb } from '../db.js';
import { sweepBlobStaging } from '../blob/staging.js';
import { blobUriFor, sha256OfBytes } from '../blob/store.js';
import { parseMbox } from './mbox.js';
import { stageFile } from './stage-file.js';
import { discardBatch, publishBatch } from './staging.js';
import { PUBLISHERS } from './publishers.js';
import type { Identity } from '../gateway/types.js';

const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);

function mboxWithAttachment(): string {
  const b64 = PNG_BYTES.toString('base64');
  return [
    'From alice@example.com Mon Jun  3 10:00:00 2024',
    'From: "Alice Roy" <alice@example.com>',
    'Subject: Receipt for the lamp',
    'Date: Mon, 3 Jun 2024 10:00:00 +0000',
    'Message-ID: <lamp-1@example.com>',
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="XYZ"',
    '',
    '--XYZ',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'Here is the receipt you asked for.',
    '--XYZ',
    'Content-Type: image/png; name="receipt.png"',
    'Content-Transfer-Encoding: base64',
    'Content-Disposition: attachment; filename="receipt.png"',
    '',
    b64,
    '--XYZ--',
    '',
  ].join('\n');
}

test('parseMbox walks MIME: plain body extracted, attachment decoded', () => {
  const messages = parseMbox(mboxWithAttachment());
  expect(messages).toHaveLength(1);
  const msg = messages[0]!;
  expect(msg.body).toBe('Here is the receipt you asked for.');
  expect(msg.attachments).toHaveLength(1);
  expect(msg.attachments[0]!.filename).toBe('receipt.png');
  expect(msg.attachments[0]!.mediaType).toBe('image/png');
  expect(msg.attachments[0]!.data.equals(PNG_BYTES)).toBe(true);
});

let db: VaultDb;
let owner: Identity;

beforeEach(() => {
  db = openVaultDb();
  const boot: BootstrapResult = bootstrapVault(db, { ownerName: 'Priya' });
  owner = {
    kind: 'owner-device',
    callerId: boot.deviceId,
    provAgentKind: 'owner',
    partyId: boot.ownerPartyId,
    mayAct: true,
  };
});

test('stage → publish: attachment bytes claim onto the message with an edge', () => {
  const staged = stageFile(db, owner, { filename: 'mail.mbox', data: mboxWithAttachment() });
  const sha = sha256OfBytes(PNG_BYTES);
  // Staged with the batch hold — the review pause outlasts any TTL.
  const hold = db.vault
    .prepare('SELECT held_by_batch FROM blob_staging WHERE sha256 = ?')
    .get(sha) as { held_by_batch: string | null };
  expect(hold.held_by_batch).toBe(staged.batchId);
  expect(sweepBlobStaging(db, { ttlHours: -1 }).expired).toEqual([]); // held = immune

  const published = publishBatch(db, owner, staged.batchId, PUBLISHERS);
  expect(published.created).toBe(1);
  expect(published.failed).toEqual([]);
  const message = db.vault
    .prepare("SELECT message_id FROM social_message WHERE external_id = 'lamp-1@example.com'")
    .get() as { message_id: string };
  const attachment = db.vault
    .prepare(
      `SELECT a.content_id, c.content_uri, c.media_type, c.title
         FROM core_attachment a JOIN core_content_item c ON c.content_id = a.content_id
        WHERE a.subject_type = 'social.message' AND a.subject_id = ?`,
    )
    .get(message.message_id) as Record<string, string>;
  expect(attachment.content_uri).toBe(blobUriFor(sha));
  expect(attachment.media_type).toBe('image/png');
  expect(attachment.title).toBe('receipt.png');
  // Claimed: the staging row is gone, the bytes stay (a content item owns them).
  expect(db.vault.prepare('SELECT count(*) AS n FROM blob_staging').get()).toEqual({ n: 0 });
  expect(db.blobs.hasSync(sha)).toBe(true);
});

test('stage → discard: hold releases and the TTL sweep reclaims the bytes', () => {
  const staged = stageFile(db, owner, { filename: 'mail.mbox', data: mboxWithAttachment() });
  const sha = sha256OfBytes(PNG_BYTES);
  discardBatch(db, owner, staged.batchId);
  db.vault.prepare('UPDATE blob_staging SET staged_at = ?').run('2000-01-01T00:00:00.000Z');
  const swept = sweepBlobStaging(db, {});
  expect(swept.expired).toContain(sha);
  expect(db.blobs.hasSync(sha)).toBe(false);
});
