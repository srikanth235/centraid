// The durable upload queue (#419.4).
//
// Own DB file, NOT the replica: `PRAGMA user_version` is owned by replica
// store-core (drop-and-rebuild on mismatch); a queued upload is unreplicated
// source-of-truth; a long drain must not contend with replica transactions
// on one `journal_mode=DELETE` handle.
//
// SECRETS: the per-blob content key is NOT persisted. `begin` returns
// `keyBase64` on every call (including resume) so the key lives only in
// memory. Presigned URLs are not persisted — they expire, and `begin`
// re-mints them.

import type { UploadSqliteDriver } from "../replica/expo-sqlite-driver";
import type { PendingUploadGroup } from "../replica/storage-accounting";
import { stableFollowupIntentId, toUploadFollowup } from "./followup-record";
import type {
  NewUploadFollowup,
  PersistedUploadFollowupRow,
  UploadFollowup,
  UploadFollowupFactory,
} from "./followup-record";
import { PENDING_PAGE_LIMIT } from "./store-limits";
import { migrateUploadSchema, SCHEMA_VERSION } from "./store-migrations";
import {
  deferItemUntil,
  dismissFailedItem,
  failedItemCount,
  failedItems,
  recentItems,
  retryFailedItem,
  retryingItems,
  sweepTerminalItems,
} from "./store-retention";
import { toItem, toPart } from "./store-rows";
import type { ItemRow, PartRow } from "./store-rows";

export type {
  NewUploadFollowup,
  UploadFollowup,
  UploadFollowupFactory,
} from "./followup-record";

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
    sha256 TEXT NOT NULL,
    local_uri TEXT NOT NULL,
    target_vault_id TEXT,
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
    receipt_json TEXT,
    edge_digest TEXT,
    settled_at TEXT,
    dismissed_at TEXT,
    next_attempt_at TEXT
  );
  CREATE INDEX IF NOT EXISTS upload_item_state ON upload_item(state, created_order);
  -- P3 (#1014): one row per (content, vault), not per content. An expression
  -- index, because SQLite counts every NULL target as distinct.
  CREATE UNIQUE INDEX IF NOT EXISTS upload_item_sha_vault
    ON upload_item(sha256, COALESCE(target_vault_id, ''));
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

export type UploadItemState =
  | "pending"
  | "begun"
  | "uploading"
  | "completing"
  | "settled"
  | "failed";

/**
 * `put` exists solely so a PUT-succeeded-but-recordPart-never-landed crash
 * replays the receipt instead of re-uploading the bytes.
 */
export type UploadPartState = "pending" | "put" | "recorded";

export interface UploadPart {
  partNumber: number;
  state: UploadPartState;
  etag?: string;
}

export interface UploadItem {
  itemId: string;
  sha256: string;
  localUri: string;
  targetVaultId?: string;
  /** P22 (#1014): sha of the file's first and last MiB, taken at enqueue.
   *  A resume re-takes it: same size, different bytes is a different file. */
  edgeDigest?: string;
  /** When `settle` ran; the retention sweep reads it (P25). */
  settledAt?: string;
  /** When the member dismissed a failed row; the sweep may then drop it. */
  dismissedAt?: string;
  /** Earliest wall-clock the drain may touch this row again (backoff). */
  nextAttemptAt?: string;
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
  targetVaultId?: string;
  edgeDigest?: string;
  mediaType?: string;
  filename?: string;
  plaintextSize: number;
  sealedSize: number;
  frameCount: number;
  partCount: number;
}

const TERMINAL: readonly UploadItemState[] = ["settled", "failed"];

export {
  PENDING_PAGE_LIMIT,
  RECENT_PAGE_LIMIT,
  TERMINAL_RETENTION_MS,
} from "./store-limits";

interface PendingGroupRow {
  vault_id: string | null;
  item_count: number;
  bytes: number | null;
  video_count: number;
}

export class UploadQueueStore {
  private constructor(private readonly driver: UploadSqliteDriver) {}

  static create(driver: UploadSqliteDriver): UploadQueueStore {
    driver.exec("PRAGMA journal_mode=WAL;");
    driver.exec("PRAGMA synchronous=FULL;");
    const version =
      driver.all<{ user_version: number }>("PRAGMA user_version")[0]
        ?.user_version ?? 0;
    if (version === 0) {
      driver.exec(DDL);
      driver.exec(`PRAGMA user_version = ${SCHEMA_VERSION};`);
    } else if (version >= 1 && version < SCHEMA_VERSION) {
      // Source-of-truth ledger: migrate transactionally and idempotently so a
      // kill mid-migration cannot brick the queue.
      migrateUploadSchema(driver, version, FOLLOWUP_DDL);
    } else if (version === SCHEMA_VERSION) {
      driver.exec(DDL);
    } else {
      // Unknown (future/foreign) version rebuilds in place. Only this module's
      // own tables are named, so nothing else in the file is collateral.
      driver.exec(`
        DROP TABLE IF EXISTS upload_part;
        DROP TABLE IF EXISTS upload_followup;
        DROP TABLE IF EXISTS upload_item;
        DROP TABLE IF EXISTS upload_meta;
      `);
      driver.exec(DDL);
      driver.exec(`PRAGMA user_version = ${SCHEMA_VERSION};`);
    }
    return new UploadQueueStore(driver);
  }

  /** Local half of D10 dedupe; the gateway's `alreadyPresent` is the other half. */
  enqueue(upload: NewUpload): UploadItem {
    return this.transaction(() => this.enqueueItem(upload));
  }

  enqueueWithFollowup(
    upload: NewUpload,
    makeFollowup: UploadFollowupFactory
  ): UploadItem {
    return this.transaction(() => {
      const item = this.enqueueItem(upload);
      this.enqueueFollowup({ itemId: item.itemId, ...makeFollowup(item) });
      return item;
    });
  }

  /**
   * One page of the queue, oldest first — never the whole ledger. A phone that
   * shot a wedding offline holds tens of thousands of non-terminal rows, and
   * an unbounded `SELECT` made *starting* a drain cost the backlog rather than
   * the work. `afterOrder` is a keyset cursor over `created_order` (UNIQUE and
   * monotonic), so paging never re-reads a row. Callers that need only totals
   * use `pendingCount` / `pendingStorageGroups`.
   */
  pending(
    limit: number = PENDING_PAGE_LIMIT,
    afterOrder = 0,
    now: string = new Date().toISOString()
  ): UploadItem[] {
    return this.driver
      .all<ItemRow>(
        `SELECT * FROM upload_item
           WHERE state NOT IN ('settled', 'failed') AND created_order > ?
             AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
           ORDER BY created_order LIMIT ?`,
        [afterOrder, now, limit]
      )
      .map(toItem);
  }

  pendingCount(): number {
    return (
      this.driver.all<{ count: number }>(
        `SELECT COUNT(*) AS count FROM upload_item
           WHERE state NOT IN ('settled', 'failed')`
      )[0]?.count ?? 0
    );
  }

  /**
   * Pending bytes per durable target vault, aggregated by SQLite: the storage
   * screen wants the numbers, not the rows behind them. `target_vault_id IS
   * NULL` stays its own group so a legacy pre-target row is reported honestly
   * as unassigned. `GLOB` not `LIKE` for the video probe — GLOB is
   * case-sensitive, matching the `startsWith("video/")` test it replaced.
   */
  pendingStorageGroups(): PendingUploadGroup[] {
    return this.driver
      .all<PendingGroupRow>(
        `SELECT target_vault_id AS vault_id,
                COUNT(*) AS item_count,
                SUM(plaintext_size) AS bytes,
                SUM(CASE WHEN media_type GLOB 'video/*' THEN 1 ELSE 0 END)
                  AS video_count
           FROM upload_item
          WHERE state NOT IN ('settled', 'failed')
          GROUP BY target_vault_id`
      )
      .map((row) => ({
        ...(row.vault_id ? { targetVaultId: row.vault_id } : {}),
        itemCount: row.item_count,
        bytes: row.bytes ?? 0,
        videoCount: row.video_count,
      }));
  }

  all(): UploadItem[] {
    return this.driver
      .all<ItemRow>(
        "SELECT * FROM upload_item ORDER BY created_order DESC LIMIT 100000"
      )
      .map(toItem);
  }

  /** The newest slice of the ledger; the retention sweep keeps it short. */
  recent(limit?: number): UploadItem[] {
    return recentItems(this.driver, limit);
  }

  /** Drop terminal rows nothing is waiting on (#1014, P25). */
  sweepTerminal(options: {
    olderThanMs: number;
    keep?: number;
    now?: number;
  }): number {
    return sweepTerminalItems(this.driver, options);
  }

  /** Terminally failed rows the member has not dismissed (#1014, P7). */
  failed(limit?: number): UploadItem[] {
    return failedItems(this.driver, limit);
  }

  failedCount(): number {
    return failedItemCount(this.driver);
  }

  /** Rows that failed and will try again, backoff window included (#1014). */
  retrying(limit?: number): UploadItem[] {
    return retryingItems(this.driver, limit);
  }

  /** Member-driven retry: back to `pending` with a fresh attempt budget. */
  retry(itemId: string): void {
    retryFailedItem(this.driver, itemId);
  }

  dismissFailed(itemId: string): void {
    dismissFailedItem(this.driver, itemId);
  }

  /** Do not touch this row before `at`; the drain skips it (backoff). */
  deferUntil(itemId: string, at: string): void {
    deferItemUntil(this.driver, itemId, at);
  }

  /** Unique key makes producer retries idempotent; one blob may feed many apps. */
  enqueueFollowup(followup: NewUploadFollowup): UploadFollowup {
    const inputJson = JSON.stringify(followup.input);
    const intentId = stableFollowupIntentId(
      followup.itemId,
      followup.shape,
      followup.action,
      inputJson
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
      ]
    );
    const row = this.driver.all<PersistedUploadFollowupRow>(
      `SELECT * FROM upload_followup
       WHERE item_id = ? AND shape = ? AND action = ? AND input_json = ?`,
      [followup.itemId, followup.shape, followup.action, inputJson]
    )[0];
    if (!row)
      throw new Error(`upload follow-up for ${followup.itemId} vanished`);
    return toUploadFollowup(row);
  }

  /** Settled bytes, oldest first. Poisoned follow-ups excluded (F4). */
  pendingFollowups(): UploadFollowup[] {
    return this.driver
      .all<PersistedUploadFollowupRow>(
        `SELECT followup.*, item.target_vault_id
         FROM upload_followup AS followup
         INNER JOIN upload_item AS item ON item.item_id = followup.item_id
         WHERE item.state = 'settled' AND followup.poisoned_at IS NULL
         ORDER BY followup.followup_id`
      )
      .map(toUploadFollowup);
  }

  hasFollowupForItem(itemId: string): boolean {
    return (
      (this.driver.all<{ count: number }>(
        "SELECT COUNT(*) AS count FROM upload_followup WHERE item_id = ?",
        [itemId]
      )[0]?.count ?? 0) > 0
    );
  }

  countFollowupAttempt(followupId: number): number {
    this.driver.run(
      "UPDATE upload_followup SET attempts = attempts + 1 WHERE followup_id = ?",
      [followupId]
    );
    return (
      this.driver.all<{ attempts: number }>(
        "SELECT attempts FROM upload_followup WHERE followup_id = ?",
        [followupId]
      )[0]?.attempts ?? 0
    );
  }

  poisonFollowup(followupId: number, reason: string): void {
    this.driver.run(
      "UPDATE upload_followup SET poisoned_at = ?, last_error = ? WHERE followup_id = ?",
      [new Date().toISOString(), reason.slice(0, 500), followupId]
    );
  }

  poisonedFollowupCount(): number {
    return (
      this.driver.all<{ count: number }>(
        "SELECT COUNT(*) AS count FROM upload_followup WHERE poisoned_at IS NOT NULL"
      )[0]?.count ?? 0
    );
  }

  clearFollowup(followupId: number): void {
    this.driver.run("DELETE FROM upload_followup WHERE followup_id = ?", [
      followupId,
    ]);
  }

  get(itemId: string): UploadItem | undefined {
    const row = this.driver.all<ItemRow>(
      "SELECT * FROM upload_item WHERE item_id = ?",
      [itemId]
    )[0];
    return row ? toItem(row) : undefined;
  }

  /**
   * The row for these bytes IN THIS VAULT (#1014, P3). Passing no vault asks
   * the unassigned-target question, not "any vault" — an unscoped answer is
   * what let one queued photograph stand in for the same photograph queued
   * for a second vault.
   */
  bySha(sha256: string, targetVaultId?: string): UploadItem | undefined {
    const row = this.driver.all<ItemRow>(
      "SELECT * FROM upload_item WHERE sha256 = ? AND COALESCE(target_vault_id, '') = ?",
      [sha256, targetVaultId ?? ""]
    )[0];
    return row ? toItem(row) : undefined;
  }

  parts(itemId: string): UploadPart[] {
    return this.driver
      .all<PartRow>(
        "SELECT part_number, state, etag FROM upload_part WHERE item_id = ? ORDER BY part_number",
        [itemId]
      )
      .map(toPart);
  }

  markBegun(itemId: string, sessionId: string): void {
    this.driver.run(
      `UPDATE upload_item SET state = 'begun', session_id = ? WHERE item_id = ?`,
      [sessionId, itemId]
    );
  }

  setState(itemId: string, state: UploadItemState): void {
    this.driver.run("UPDATE upload_item SET state = ? WHERE item_id = ?", [
      state,
      itemId,
    ]);
  }

  /** Give an attempt back: the gateway was never reached, so nothing about
   *  this item was tried (#1014). */
  uncountAttempt(itemId: string): void {
    this.driver.run(
      "UPDATE upload_item SET attempts = MAX(attempts - 1, 0) WHERE item_id = ?",
      [itemId]
    );
  }

  countAttempt(itemId: string): void {
    this.driver.run(
      "UPDATE upload_item SET attempts = attempts + 1 WHERE item_id = ?",
      [itemId]
    );
  }

  /**
   * Persist the ETag BEFORE the gateway acknowledges it: a crash between PUT
   * and receipt must find the ETag on disk, or the next drain re-uploads bytes
   * the provider already holds.
   */
  markPartPut(itemId: string, partNumber: number, etag: string): void {
    this.driver.run(
      `UPDATE upload_part SET state = 'put', etag = ? WHERE item_id = ? AND part_number = ?`,
      [etag, itemId, partNumber]
    );
  }

  markPartRecorded(itemId: string, partNumber: number, etag: string): void {
    this.driver.run(
      `INSERT INTO upload_part(item_id, part_number, state, etag) VALUES (?, ?, 'recorded', ?)
         ON CONFLICT(item_id, part_number) DO UPDATE SET state = 'recorded', etag = excluded.etag`,
      [itemId, partNumber, etag]
    );
  }

  settle(itemId: string, receipt: Record<string, unknown>): void {
    this.driver.run(
      `UPDATE upload_item
          SET state = 'settled', last_error = NULL, receipt_json = ?,
              settled_at = ?, next_attempt_at = NULL
        WHERE item_id = ?`,
      [JSON.stringify(receipt), new Date().toISOString(), itemId]
    );
  }

  fail(itemId: string, reason: string, terminal: boolean): void {
    this.driver.run(
      "UPDATE upload_item SET state = ?, last_error = ? WHERE item_id = ?",
      [terminal ? "failed" : "pending", reason.slice(0, 500), itemId]
    );
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
    // P3 (#1014): the lookup is keyed by (sha, vault). The old retarget branch
    // — adopting an unassigned row for the first vault that asked — is gone
    // with it: an unassigned row is its own key now, and adopting it would put
    // the same bytes in exactly one of the two vaults that wanted them.
    const existing = this.bySha(upload.sha256, upload.targetVaultId);
    if (existing) {
      // F6: re-enqueue of a failed item revives it; do not report success over a stuck row.
      if (existing.state === "failed") {
        this.driver.run(
          `UPDATE upload_item
              SET state = 'pending', attempts = 0, last_error = NULL,
                  next_attempt_at = NULL, dismissed_at = NULL
            WHERE item_id = ?`,
          [existing.itemId]
        );
        return this.require(existing.itemId);
      }
      return this.require(existing.itemId);
    }
    const createdOrder = this.nextOrder();
    this.driver.run(
      `INSERT INTO upload_item(
         item_id, sha256, local_uri, target_vault_id, media_type, filename, plaintext_size,
         sealed_size, frame_count, part_count, state, created_order, attempts, edge_digest)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, 0, ?)`,
      [
        upload.itemId,
        upload.sha256,
        upload.localUri,
        upload.targetVaultId ?? null,
        upload.mediaType ?? null,
        upload.filename ?? null,
        upload.plaintextSize,
        upload.sealedSize,
        upload.frameCount,
        upload.partCount,
        createdOrder,
        upload.edgeDigest ?? null,
      ]
    );
    for (let partNumber = 1; partNumber <= upload.partCount; partNumber += 1) {
      this.driver.run(
        `INSERT INTO upload_part(item_id, part_number, state) VALUES (?, ?, 'pending')`,
        [upload.itemId, partNumber]
      );
    }
    this.driver.run(
      `INSERT INTO upload_meta(key, value) VALUES ('nextOrder', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [createdOrder + 1]
    );
    return this.require(upload.itemId);
  }

  private nextOrder(): number {
    return (
      this.driver.all<{ value: number }>(
        "SELECT value FROM upload_meta WHERE key = 'nextOrder'"
      )[0]?.value ?? 1
    );
  }

  private transaction<T>(work: () => T): T {
    this.driver.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.driver.exec("COMMIT");
      return result;
    } catch (error) {
      this.driver.exec("ROLLBACK");
      throw error;
    }
  }
}
