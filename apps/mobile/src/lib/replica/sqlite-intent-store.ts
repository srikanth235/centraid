import {
  buildIntentOutcome,
  ReplicaProtocolError,
} from "@centraid/client/replica/native";
import type {
  IntentRecordStore,
  IntentOutcome,
  IntentState,
  NewStoredIntent,
  ReplicaIntent,
  ReplicaSqliteDriver,
} from "@centraid/client/replica/native";

const DDL = `
  CREATE TABLE IF NOT EXISTS replica_intent_outbox (
    intent_id TEXT PRIMARY KEY,
    created_order INTEGER NOT NULL UNIQUE,
    state TEXT NOT NULL,
    payload_hash TEXT NOT NULL,
    record_json TEXT NOT NULL,
    enqueued_at TEXT
  );
  CREATE INDEX IF NOT EXISTS replica_intent_outbox_state
    ON replica_intent_outbox(state, created_order);
  CREATE TABLE IF NOT EXISTS replica_intent_meta (
    key TEXT PRIMARY KEY,
    value INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS replica_intent_attention (
    intent_id TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    app_id TEXT NOT NULL,
    action TEXT NOT NULL,
    reason TEXT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS replica_intent_outcome (
    intent_id TEXT PRIMARY KEY,
    settled_at TEXT NOT NULL,
    record_json TEXT NOT NULL
  );
`;

/** Journal cap: `listSettled` refuses to read past this, so older rows are unreachable. */
const SETTLED_JOURNAL_LIMIT = 5_000;

interface StoredIntentRow {
  record_json: string;
}

export interface NativeIntentAttention {
  intentId: string;
  status: "denied" | "failed" | "conflict";
  appId: string;
  action: string;
  reason?: string;
  createdAt: string;
}

interface AttentionRow {
  intent_id: string;
  status: "denied" | "failed" | "conflict";
  app_id: string;
  action: string;
  reason: string | null;
  created_at: string;
}

/**
 * The React Native outbox: {@link IntentRecordStore} over SQLite. Its tables
 * are its own inside the shared replica database, so a schema rebuild, `wipe`
 * or rebootstrap never touches queued intents.
 */
export class SqliteIntentStore implements IntentRecordStore {
  private constructor(private readonly driver: ReplicaSqliteDriver) {}

  static create(driver: ReplicaSqliteDriver): SqliteIntentStore {
    driver.exec(DDL);
    // Durable member state: widen it by ALTER, never by rebuild.
    const columns = driver.all<{ name: string }>(
      "PRAGMA table_info(replica_intent_outbox)"
    );
    if (!columns.some((column) => column.name === "enqueued_at")) {
      driver.exec(
        "ALTER TABLE replica_intent_outbox ADD COLUMN enqueued_at TEXT"
      );
    }
    return new SqliteIntentStore(driver);
  }

  async add(intent: NewStoredIntent): Promise<ReplicaIntent> {
    return this.transaction(() => {
      const existing = this.read(intent.intentId);
      if (existing) {
        if (existing.payloadHash !== intent.payloadHash) {
          throw new ReplicaProtocolError(
            `Intent id ${intent.intentId} was reused with another payload`
          );
        }
        return existing;
      }
      const createdOrder = this.nextOrder();
      const record: ReplicaIntent = { ...clone(intent), createdOrder };
      this.insert(record);
      this.driver.run(
        `INSERT INTO replica_intent_meta(key, value) VALUES ('nextOrder', ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        [createdOrder + 1]
      );
      return clone(record);
    });
  }

  async get(intentId: string): Promise<ReplicaIntent | undefined> {
    return this.read(intentId);
  }

  async list(states?: readonly IntentState[]): Promise<ReplicaIntent[]> {
    const selected = states ? new Set(states) : undefined;
    return this.driver
      .all<StoredIntentRow>(
        "SELECT record_json FROM replica_intent_outbox ORDER BY created_order"
      )
      .map((row) => parseIntent(row.record_json))
      .filter((intent) => !selected || selected.has(intent.state));
  }

  async claimNext(): Promise<ReplicaIntent | undefined> {
    return this.transaction(() => {
      const row = this.driver.all<StoredIntentRow>(
        `SELECT record_json FROM replica_intent_outbox
          WHERE state = 'queued' ORDER BY created_order LIMIT 1`
      )[0];
      if (!row) return undefined;
      const queued = parseIntent(row.record_json);
      const claimed: ReplicaIntent = {
        ...queued,
        state: "sending",
        attempts: queued.attempts + 1,
        reason: undefined,
      };
      this.insert(claimed);
      return clone(claimed);
    });
  }

  async transition(
    intentId: string,
    allowed: readonly IntentState[],
    patch: Partial<ReplicaIntent>
  ): Promise<ReplicaIntent> {
    return this.transaction(() => {
      const updated = this.applyPatch(intentId, allowed, patch, "transition");
      this.insert(updated);
      return clone(updated);
    });
  }

  async settle(
    intentId: string,
    allowed: readonly IntentState[],
    patch: Partial<ReplicaIntent>
  ): Promise<ReplicaIntent> {
    return this.transaction(() => {
      const settled = this.applyPatch(intentId, allowed, patch, "settle");
      if (
        settled.state === "denied" ||
        settled.state === "failed" ||
        settled.conflict !== undefined
      ) {
        const attentionStatus = settled.conflict ? "conflict" : settled.state;
        this.driver.run(
          `INSERT INTO replica_intent_attention
             (intent_id, status, app_id, action, reason, created_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(intent_id) DO UPDATE SET
             status = excluded.status, reason = excluded.reason`,
          [
            settled.intentId,
            attentionStatus,
            settled.appId,
            settled.action,
            settled.reason ?? null,
            new Date().toISOString(),
          ]
        );
      }
      const outcome = buildIntentOutcome(settled);
      this.driver.run(
        `INSERT INTO replica_intent_outcome(intent_id, settled_at, record_json)
         VALUES (?, ?, ?)
         ON CONFLICT(intent_id) DO UPDATE SET
           settled_at = excluded.settled_at,
           record_json = excluded.record_json`,
        [
          outcome.intentId,
          outcome.settledAt ?? new Date().toISOString(),
          stringify(outcome),
        ]
      );
      this.driver.run("DELETE FROM replica_intent_outbox WHERE intent_id = ?", [
        intentId,
      ]);
      this.pruneOutcomeJournal();
      return clone(settled);
    });
  }

  async listSettled(limit = 500): Promise<IntentOutcome[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 5_000)
      throw new ReplicaProtocolError("Settled outcome limit is invalid");
    return this.driver
      .all<{ record_json: string }>(
        `SELECT record_json FROM replica_intent_outcome
          ORDER BY settled_at DESC, intent_id DESC LIMIT ?`,
        [limit]
      )
      .map((row) => parseOutcome(row.record_json));
  }

  async clear(): Promise<void> {
    this.transaction(() => {
      this.driver.run("DELETE FROM replica_intent_outbox", []);
      this.driver.run("DELETE FROM replica_intent_meta", []);
      this.driver.run("DELETE FROM replica_intent_attention", []);
      this.driver.run("DELETE FROM replica_intent_outcome", []);
      return undefined;
    });
  }

  /** First admission per queued intent; absent for rows queued before the column. */
  enqueuedTimes(): Map<string, string> {
    const rows = this.driver.all<{
      intent_id: string;
      enqueued_at: string | null;
    }>("SELECT intent_id, enqueued_at FROM replica_intent_outbox");
    return new Map(
      rows.flatMap((row) =>
        row.enqueued_at ? [[row.intent_id, row.enqueued_at] as const] : []
      )
    );
  }

  attention(): NativeIntentAttention[] {
    return this.driver
      .all<AttentionRow>(
        `SELECT intent_id, status, app_id, action, reason, created_at
           FROM replica_intent_attention ORDER BY created_at DESC`
      )
      .map((row) => ({
        intentId: row.intent_id,
        status: row.status,
        appId: row.app_id,
        action: row.action,
        ...(row.reason ? { reason: row.reason } : {}),
        createdAt: row.created_at,
      }));
  }

  dismissAttention(intentId: string): void {
    this.driver.run(
      "DELETE FROM replica_intent_attention WHERE intent_id = ?",
      [intentId]
    );
  }

  close(): void {
    // The session owns the shared op-sqlite handle; closing runs through the store.
  }

  async destroy(): Promise<void> {
    await this.clear();
  }

  private applyPatch(
    intentId: string,
    allowed: readonly IntentState[],
    patch: Partial<ReplicaIntent>,
    verb: "transition" | "settle"
  ): ReplicaIntent {
    const existing = this.read(intentId);
    if (!existing) throw new ReplicaProtocolError(`Unknown intent ${intentId}`);
    if (!allowed.includes(existing.state)) {
      throw new ReplicaProtocolError(
        `Intent ${intentId} cannot ${verb} from ${existing.state}`
      );
    }
    // Spread the patch directly (not JSON-cloned) so an explicit `reason:
    // undefined` clears the field, matching the memory/IndexedDB stores.
    return {
      ...existing,
      ...patch,
      intentId,
      createdOrder: existing.createdOrder,
    };
  }

  private read(intentId: string): ReplicaIntent | undefined {
    const row = this.driver.all<StoredIntentRow>(
      "SELECT record_json FROM replica_intent_outbox WHERE intent_id = ?",
      [intentId]
    )[0];
    return row ? parseIntent(row.record_json) : undefined;
  }

  /** Keep `enqueued_at` out of the conflict clause: the first insert stamps it for good. */
  private insert(record: ReplicaIntent): void {
    this.driver.run(
      `INSERT INTO replica_intent_outbox(intent_id, created_order, state, payload_hash, record_json, enqueued_at)
         VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(intent_id) DO UPDATE SET
         created_order = excluded.created_order,
         state = excluded.state,
         payload_hash = excluded.payload_hash,
         record_json = excluded.record_json`,
      [
        record.intentId,
        record.createdOrder,
        record.state,
        record.payloadHash,
        stringify(record),
        new Date().toISOString(),
      ]
    );
  }

  /** Oldest settled first. */
  private pruneOutcomeJournal(): void {
    const [count] = this.driver.all<{ rows: number }>(
      "SELECT COUNT(*) AS rows FROM replica_intent_outcome"
    );
    if ((count?.rows ?? 0) <= SETTLED_JOURNAL_LIMIT) return;
    this.driver.run(
      `DELETE FROM replica_intent_outcome WHERE intent_id NOT IN (
         SELECT intent_id FROM replica_intent_outcome
          ORDER BY settled_at DESC, intent_id DESC LIMIT ?
       )`,
      [SETTLED_JOURNAL_LIMIT]
    );
  }

  private nextOrder(): number {
    const row = this.driver.all<{ value: number }>(
      "SELECT value FROM replica_intent_meta WHERE key = 'nextOrder'"
    )[0];
    return row?.value ?? 1;
  }

  /**
   * `work()` must be synchronous, as the guard enforces: BEGIN IMMEDIATE holds
   * the write lock on the one handle the replica store shares, so an await
   * would enlist a foreign write here and roll it back with ours.
   */
  private transaction<T>(work: () => T): T {
    this.driver.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      if (result instanceof Promise) {
        throw new ReplicaProtocolError(
          "Intent-store transactions must run synchronous work"
        );
      }
      this.driver.exec("COMMIT");
      return result;
    } catch (error) {
      this.driver.exec("ROLLBACK");
      throw error;
    }
  }
}

function clone<T>(value: T): T {
  // oxlint-disable-next-line unicorn/prefer-structured-clone -- (#419) Hermes ships no structuredClone; intents are JSON-safe by contract; governance: allow-no-unjustified-suppressions runtime capability gap
  return JSON.parse(JSON.stringify(value)) as T;
}

function stringify(record: ReplicaIntent | IntentOutcome): string {
  return JSON.stringify(record);
}

function parseIntent(json: string): ReplicaIntent {
  return JSON.parse(json) as ReplicaIntent;
}

function parseOutcome(json: string): IntentOutcome {
  return JSON.parse(json) as IntentOutcome;
}
