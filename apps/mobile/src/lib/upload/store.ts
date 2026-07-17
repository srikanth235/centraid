// The durable upload queue (#419 M0.4) — the correctness kernel.
//
// DB FILE: its own, NOT the replica database. Three reasons:
//
//  1. `PRAGMA user_version` is owned by the replica store core, which keys its
//     drop-and-rebuild on it (store-core.ts `initializeSchema`). Sharing the
//     file leaves this schema no version marker of its own.
//  2. Lifecycle is opposite. The replica is disposable derived state — it is
//     wiped and rebootstrapped on any schema mismatch. A queued upload is
//     unreplicated source-of-truth: losing it loses a photo that exists
//     nowhere else yet. Coupling it to a disposable file is a category error.
//     (`replica_intent_outbox` can share that file because an intent is
//     replica-protocol-scoped and settles in seconds; an upload can outlive
//     many rebootstraps while a 4 GB video drains over days.)
//  3. A long drain writing part receipts should not contend with replica
//     change-batch transactions on one `journal_mode=DELETE` handle.
//
// SECRETS: the per-blob content key is deliberately NOT persisted. `begin`
// returns `keyBase64` on every call, including when it resumes an existing
// session, so the key is re-fetched per drain and lives only in memory. Nor
// are presigned URLs persisted — they expire, and `begin` re-mints them.

import type { ReplicaSqliteDriver } from '@centraid/client/replica/native';
import { migrateUploadSchema, SCHEMA_VERSION } from './store-migrations';
import { toItem, toPart, type ItemRow, type PartRow } from './store-rows';
import {
  stableFollowupIntentId,
  toUploadFollowup,
  type NewUploadFollowup,
  type PersistedUploadFollowupRow,
  type UploadFollowup,
  type UploadFollowupFactory,
} from './followup-record';

export type {
  NewUploadFollowup,
  UploadDerivativeFollowup,
  UploadFollowup,
  UploadFollowupFactory,
} from './followup-record';

const FOLLOWUP_DDL = `
  CREATE TABLE IF NOT EXISTS upload_followup (
    followup_id INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id TEXT NOT NULL,
    intent_id TEXT NOT NULL UNIQUE,
    shape TEXT NOT NULL,
    action TEXT NOT NULL,
    input_json TEXT NOT NULL,
    derivatives_json TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    poisoned_at TEXT,
    last_error TEXT,
    FOREIGN KEY (item_id) REFERENCES upload_item(item_id) ON DELETE CASCADE,
    UNIQUE (item_id, shape, action, input_json)
  );
  CREATE INDEX IF NOT EXISTS upload_followup_item ON upload_followup(item_id, followup_id);
`;

const DDL = `
  CREATE TABLE IF NOT EXISTS upload_item (
    item_id TEXT PRIMARY KEY,
    sha256 TEXT NOT NULL UNIQUE,
    local_uri TEXT NOT NULL,
    media_type TEXT,
    filename TEXT,
    plaintext_size INTEGER NOT NULL,
    sealed_size INTEGER NOT NULL,
    frame_count INTEGER NOT NULL,
    part_count INTEGER NOT NULL,
    state TEXT NOT NULL,
    session_id TEXT,
    created_order INTEGER NOT NULL UNIQUE,
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    receipt_json TEXT
  );
  CREATE INDEX IF NOT EXISTS upload_item_state ON upload_item(state, created_order);
  CREATE TABLE IF NOT EXISTS upload_part (
    item_id TEXT NOT NULL,
    part_number INTEGER NOT NULL,
    state TEXT NOT NULL,
    etag TEXT,
    PRIMARY KEY (item_id, part_number)
  );
  CREATE TABLE IF NOT EXISTS upload_meta (
    key TEXT PRIMARY KEY,
    value INTEGER NOT NULL
  );
  ${FOLLOWUP_DDL}
`;

/**
 * `pending`  enqueued, sha known, no session yet
 * `begun`    gateway session open
 * `uploading` at least one part in flight or done
 * `completing` all parts recorded, completion requested
 * `settled`  casAck receipt persisted (terminal)
 * `failed`   gave up after too many attempts (terminal until retried)
 */
export type UploadItemState =
  | 'pending'
  | 'begun'
  | 'uploading'
  | 'completing'
  | 'settled'
  | 'failed';

/**
 * `pending`  not yet uploaded
 * `put`      bytes accepted by the provider, ETag captured, receipt NOT yet
 *            acknowledged by the gateway. This state exists solely so the
 *            PUT-succeeded-but-recordPart-never-landed crash replays the
 *            receipt instead of re-uploading the bytes.
 * `recorded` gateway holds the ETag
 */
export type UploadPartState = 'pending' | 'put' | 'recorded';

export interface UploadPart {
  partNumber: number;
  state: UploadPartState;
  etag?: string;
}

export interface UploadItem {
  itemId: string;
  sha256: string;
  localUri: string;
  mediaType?: string;
  filename?: string;
  plaintextSize: number;
  sealedSize: number;
  frameCount: number;
  partCount: number;
  state: UploadItemState;
  sessionId?: string;
  createdOrder: number;
  attempts: number;
  lastError?: string;
  receipt?: Record<string, unknown>;
}

export interface NewUpload {
  itemId: string;
  sha256: string;
  localUri: string;
  mediaType?: string;
  filename?: string;
  plaintextSize: number;
  sealedSize: number;
  frameCount: number;
  partCount: number;
}

const TERMINAL: readonly UploadItemState[] = ['settled', 'failed'];

export class UploadQueueStore {
  private constructor(private readonly driver: ReplicaSqliteDriver) {}

  static create(driver: ReplicaSqliteDriver): UploadQueueStore {
    driver.exec('PRAGMA journal_mode=WAL;');
    driver.exec('PRAGMA synchronous=FULL;');
    const version =
      driver.all<{ user_version: number }>('PRAGMA user_version')[0]?.user_version ?? 0;
    if (version === 0) {
      // Fresh database: build the current schema in one shot.
      driver.exec(DDL);
      driver.exec(`PRAGMA user_version = ${SCHEMA_VERSION};`);
    } else if (version >= 1 && version < SCHEMA_VERSION) {
      // The upload ledger is source-of-truth. Migrate transactionally and
      // idempotently (see store-migrations.ts) so a kill mid-migration cannot
      // brick the queue and lose a photo that exists nowhere else yet.
      migrateUploadSchema(driver, version, FOLLOWUP_DDL);
    } else if (version !== SCHEMA_VERSION) {
      // v0 pre-release: an unknown (future/foreign) version rebuilds in place
      // rather than migrating. Only this module's own tables are named, so
      // nothing else in the file is collateral.
      driver.exec(`
        DROP TABLE IF EXISTS upload_part;
        DROP TABLE IF EXISTS upload_followup;
        DROP TABLE IF EXISTS upload_item;
        DROP TABLE IF EXISTS upload_meta;
      `);
      driver.exec(DDL);
      driver.exec(`PRAGMA user_version = ${SCHEMA_VERSION};`);
    } else {
      driver.exec(DDL);
    }
    return new UploadQueueStore(driver);
  }

  /**
   * Idempotent by content sha: re-enqueuing bytes already queued or settled
   * returns the existing item rather than creating a second upload of the same
   * object. This is the local half of D10 dedupe; the gateway's
   * `alreadyPresent` is the other half.
   */
  enqueue(upload: NewUpload): UploadItem {
    return this.transaction(() => this.enqueueItem(upload));
  }

  /** Atomically persist addressed bytes and the canonical work they enable. */
  enqueueWithFollowup(upload: NewUpload, makeFollowup: UploadFollowupFactory): UploadItem {
    return this.transaction(() => {
      const item = this.enqueueItem(upload);
      this.enqueueFollowup({ itemId: item.itemId, ...makeFollowup(item) });
      return item;
    });
  }

  /** Every non-terminal item, oldest first — the recovery set after a restart. */
  pending(): UploadItem[] {
    return this.driver
      .all<ItemRow>(
        `SELECT * FROM upload_item WHERE state NOT IN ('settled', 'failed')
           ORDER BY created_order`,
      )
      .map(toItem);
  }

  /** Bounded local ledger for UI backup-state reconciliation. */
  all(): UploadItem[] {
    return this.driver
      .all<ItemRow>('SELECT * FROM upload_item ORDER BY created_order DESC LIMIT 100000')
      .map(toItem);
  }

  /**
   * Durably attach the canonical mutation before transfer starts. The unique
   * key makes producer retries idempotent while still allowing one blob to
   * feed more than one app/entity.
   */
  enqueueFollowup(followup: NewUploadFollowup): UploadFollowup {
    const inputJson = JSON.stringify(followup.input);
    const intentId = stableFollowupIntentId(
      followup.itemId,
      followup.shape,
      followup.action,
      inputJson,
    );
    this.driver.run(
      `INSERT OR IGNORE INTO upload_followup(
         item_id, intent_id, shape, action, input_json, derivatives_json)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        followup.itemId,
        intentId,
        followup.shape,
        followup.action,
        inputJson,
        followup.derivatives ? JSON.stringify(followup.derivatives) : null,
      ],
    );
    const row = this.driver.all<PersistedUploadFollowupRow>(
      `SELECT * FROM upload_followup
       WHERE item_id = ? AND shape = ? AND action = ? AND input_json = ?`,
      [followup.itemId, followup.shape, followup.action, inputJson],
    )[0];
    if (!row) throw new Error(`upload follow-up for ${followup.itemId} vanished`);
    return toUploadFollowup(row);
  }

  /**
   * Canonical work whose bytes have a terminal casAck, oldest first. Poisoned
   * follow-ups are excluded: a record that has exhausted its replay attempts is
   * quarantined so it can neither replay again nor block the rest (F4).
   */
  pendingFollowups(): UploadFollowup[] {
    return this.driver
      .all<PersistedUploadFollowupRow>(
        `SELECT followup.* FROM upload_followup AS followup
         INNER JOIN upload_item AS item ON item.item_id = followup.item_id
         WHERE item.state = 'settled' AND followup.poisoned_at IS NULL
         ORDER BY followup.followup_id`,
      )
      .map(toUploadFollowup);
  }

  /** Count one failed replay attempt and return the new total (F4). */
  countFollowupAttempt(followupId: number): number {
    this.driver.run('UPDATE upload_followup SET attempts = attempts + 1 WHERE followup_id = ?', [
      followupId,
    ]);
    return (
      this.driver.all<{ attempts: number }>(
        'SELECT attempts FROM upload_followup WHERE followup_id = ?',
        [followupId],
      )[0]?.attempts ?? 0
    );
  }

  /** Terminally quarantine a follow-up that has stopped being replayable (F4). */
  poisonFollowup(followupId: number, reason: string): void {
    this.driver.run(
      'UPDATE upload_followup SET poisoned_at = ?, last_error = ? WHERE followup_id = ?',
      [new Date().toISOString(), reason.slice(0, 500), followupId],
    );
  }

  /** How many settled-byte follow-ups are quarantined — a health signal for boot. */
  poisonedFollowupCount(): number {
    return (
      this.driver.all<{ count: number }>(
        'SELECT COUNT(*) AS count FROM upload_followup WHERE poisoned_at IS NOT NULL',
      )[0]?.count ?? 0
    );
  }

  clearFollowup(followupId: number): void {
    this.driver.run('DELETE FROM upload_followup WHERE followup_id = ?', [followupId]);
  }

  get(itemId: string): UploadItem | undefined {
    const row = this.driver.all<ItemRow>('SELECT * FROM upload_item WHERE item_id = ?', [
      itemId,
    ])[0];
    return row ? toItem(row) : undefined;
  }

  bySha(sha256: string): UploadItem | undefined {
    const row = this.driver.all<ItemRow>('SELECT * FROM upload_item WHERE sha256 = ?', [sha256])[0];
    return row ? toItem(row) : undefined;
  }

  parts(itemId: string): UploadPart[] {
    return this.driver
      .all<PartRow>(
        'SELECT part_number, state, etag FROM upload_part WHERE item_id = ? ORDER BY part_number',
        [itemId],
      )
      .map(toPart);
  }

  /** Record an open gateway session and move the item into the transfer states. */
  markBegun(itemId: string, sessionId: string): void {
    this.driver.run(`UPDATE upload_item SET state = 'begun', session_id = ? WHERE item_id = ?`, [
      sessionId,
      itemId,
    ]);
  }

  setState(itemId: string, state: UploadItemState): void {
    this.driver.run('UPDATE upload_item SET state = ? WHERE item_id = ?', [state, itemId]);
  }

  countAttempt(itemId: string): void {
    this.driver.run('UPDATE upload_item SET attempts = attempts + 1 WHERE item_id = ?', [itemId]);
  }

  /**
   * Persist the ETag the provider returned BEFORE the gateway has acknowledged
   * it. Ordering is the whole point: a crash between the PUT and the receipt
   * must find the ETag on disk, or the next drain re-uploads bytes the
   * provider already holds.
   */
  markPartPut(itemId: string, partNumber: number, etag: string): void {
    this.driver.run(
      `UPDATE upload_part SET state = 'put', etag = ? WHERE item_id = ? AND part_number = ?`,
      [etag, itemId, partNumber],
    );
  }

  markPartRecorded(itemId: string, partNumber: number, etag: string): void {
    this.driver.run(
      `INSERT INTO upload_part(item_id, part_number, state, etag) VALUES (?, ?, 'recorded', ?)
         ON CONFLICT(item_id, part_number) DO UPDATE SET state = 'recorded', etag = excluded.etag`,
      [itemId, partNumber, etag],
    );
  }

  /** Terminal, and the only place a casAck receipt is written. */
  settle(itemId: string, receipt: Record<string, unknown>): void {
    this.driver.run(
      `UPDATE upload_item SET state = 'settled', last_error = NULL, receipt_json = ?
         WHERE item_id = ?`,
      [JSON.stringify(receipt), itemId],
    );
  }

  fail(itemId: string, reason: string, terminal: boolean): void {
    this.driver.run('UPDATE upload_item SET state = ?, last_error = ? WHERE item_id = ?', [
      terminal ? 'failed' : 'pending',
      reason.slice(0, 500),
      itemId,
    ]);
  }

  isTerminal(itemId: string): boolean {
    const item = this.get(itemId);
    return item !== undefined && TERMINAL.includes(item.state);
  }

  close(): void {
    this.driver.close();
  }

  private require(itemId: string): UploadItem {
    const item = this.get(itemId);
    if (!item) throw new Error(`upload item ${itemId} vanished`);
    return item;
  }

  private enqueueItem(upload: NewUpload): UploadItem {
    const existing = this.bySha(upload.sha256);
    if (existing) {
      // F6: a terminally-failed item is not a dead end. Re-enqueuing the same
      // bytes revives it with fresh attempts and a cleared error, so the next
      // backup run retries the transfer instead of a producer reporting a
      // phantom success over a stuck row.
      if (existing.state === 'failed') {
        this.driver.run(
          `UPDATE upload_item SET state = 'pending', attempts = 0, last_error = NULL
             WHERE item_id = ?`,
          [existing.itemId],
        );
        return this.require(existing.itemId);
      }
      return existing;
    }
    const createdOrder = this.nextOrder();
    this.driver.run(
      `INSERT INTO upload_item(
         item_id, sha256, local_uri, media_type, filename, plaintext_size,
         sealed_size, frame_count, part_count, state, created_order, attempts)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, 0)`,
      [
        upload.itemId,
        upload.sha256,
        upload.localUri,
        upload.mediaType ?? null,
        upload.filename ?? null,
        upload.plaintextSize,
        upload.sealedSize,
        upload.frameCount,
        upload.partCount,
        createdOrder,
      ],
    );
    for (let partNumber = 1; partNumber <= upload.partCount; partNumber += 1) {
      this.driver.run(
        `INSERT INTO upload_part(item_id, part_number, state) VALUES (?, ?, 'pending')`,
        [upload.itemId, partNumber],
      );
    }
    this.driver.run(
      `INSERT INTO upload_meta(key, value) VALUES ('nextOrder', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [createdOrder + 1],
    );
    return this.require(upload.itemId);
  }

  private nextOrder(): number {
    return (
      this.driver.all<{ value: number }>("SELECT value FROM upload_meta WHERE key = 'nextOrder'")[0]
        ?.value ?? 1
    );
  }

  private transaction<T>(work: () => T): T {
    this.driver.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.driver.exec('COMMIT');
      return result;
    } catch (error) {
      this.driver.exec('ROLLBACK');
      throw error;
    }
  }
}
