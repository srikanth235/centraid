import {
  ReplicaProtocolError,
  type IntentRecordStore,
  type IntentState,
  type NewStoredIntent,
  type ReplicaIntent,
  type ReplicaSqliteDriver,
} from '@centraid/client/replica/native';

const DDL = `
  CREATE TABLE IF NOT EXISTS replica_intent_outbox (
    intent_id TEXT PRIMARY KEY,
    created_order INTEGER NOT NULL UNIQUE,
    state TEXT NOT NULL,
    payload_hash TEXT NOT NULL,
    record_json TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS replica_intent_outbox_state
    ON replica_intent_outbox(state, created_order);
  CREATE TABLE IF NOT EXISTS replica_intent_meta (
    key TEXT PRIMARY KEY,
    value INTEGER NOT NULL
  );
`;

interface StoredIntentRow {
  record_json: string;
}

/**
 * SQLite-backed durable outbox for React Native, satisfying {@link IntentRecordStore}
 * with the same guarantees as the browser IndexedDB store: idempotent add
 * (an id reused with a different payload hash is rejected), atomic claimNext,
 * and settle-returns-while-scrubbing the sensitive input. It lives in its own
 * tables in the shared replica database, so the store's schema rebuild, `wipe`
 * and rebootstrap never touch queued intents.
 */
export class SqliteIntentStore implements IntentRecordStore {
  private constructor(private readonly driver: ReplicaSqliteDriver) {}

  static create(driver: ReplicaSqliteDriver): SqliteIntentStore {
    driver.exec(DDL);
    return new SqliteIntentStore(driver);
  }

  async add(intent: NewStoredIntent): Promise<ReplicaIntent> {
    return this.transaction(() => {
      const existing = this.read(intent.intentId);
      if (existing) {
        if (existing.payloadHash !== intent.payloadHash) {
          throw new ReplicaProtocolError(
            `Intent id ${intent.intentId} was reused with another payload`,
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
        [createdOrder + 1],
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
      .all<StoredIntentRow>('SELECT record_json FROM replica_intent_outbox ORDER BY created_order')
      .map((row) => parseIntent(row.record_json))
      .filter((intent) => !selected || selected.has(intent.state));
  }

  async claimNext(): Promise<ReplicaIntent | undefined> {
    return this.transaction(() => {
      const row = this.driver.all<StoredIntentRow>(
        `SELECT record_json FROM replica_intent_outbox
          WHERE state = 'queued' ORDER BY created_order LIMIT 1`,
      )[0];
      if (!row) return undefined;
      const queued = parseIntent(row.record_json);
      const claimed: ReplicaIntent = {
        ...queued,
        state: 'sending',
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
    patch: Partial<ReplicaIntent>,
  ): Promise<ReplicaIntent> {
    return this.transaction(() => {
      const updated = this.applyPatch(intentId, allowed, patch, 'transition');
      this.insert(updated);
      return clone(updated);
    });
  }

  async settle(
    intentId: string,
    allowed: readonly IntentState[],
    patch: Partial<ReplicaIntent>,
  ): Promise<ReplicaIntent> {
    return this.transaction(() => {
      const settled = this.applyPatch(intentId, allowed, patch, 'settle');
      this.driver.run('DELETE FROM replica_intent_outbox WHERE intent_id = ?', [intentId]);
      return clone(settled);
    });
  }

  async clear(): Promise<void> {
    this.transaction(() => {
      this.driver.run('DELETE FROM replica_intent_outbox', []);
      this.driver.run('DELETE FROM replica_intent_meta', []);
      return undefined;
    });
  }

  close(): void {
    // The op-sqlite handle is owned by the session (shared with the store); the
    // queue closes through the store, not here.
  }

  async destroy(): Promise<void> {
    await this.clear();
  }

  private applyPatch(
    intentId: string,
    allowed: readonly IntentState[],
    patch: Partial<ReplicaIntent>,
    verb: 'transition' | 'settle',
  ): ReplicaIntent {
    const existing = this.read(intentId);
    if (!existing) throw new ReplicaProtocolError(`Unknown intent ${intentId}`);
    if (!allowed.includes(existing.state)) {
      throw new ReplicaProtocolError(`Intent ${intentId} cannot ${verb} from ${existing.state}`);
    }
    // Spread the patch directly (not JSON-cloned) so an explicit `reason:
    // undefined` clears the field, matching the memory/IndexedDB stores.
    return { ...existing, ...patch, intentId, createdOrder: existing.createdOrder };
  }

  private read(intentId: string): ReplicaIntent | undefined {
    const row = this.driver.all<StoredIntentRow>(
      'SELECT record_json FROM replica_intent_outbox WHERE intent_id = ?',
      [intentId],
    )[0];
    return row ? parseIntent(row.record_json) : undefined;
  }

  private insert(record: ReplicaIntent): void {
    this.driver.run(
      `INSERT INTO replica_intent_outbox(intent_id, created_order, state, payload_hash, record_json)
         VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(intent_id) DO UPDATE SET
         created_order = excluded.created_order,
         state = excluded.state,
         payload_hash = excluded.payload_hash,
         record_json = excluded.record_json`,
      [record.intentId, record.createdOrder, record.state, record.payloadHash, stringify(record)],
    );
  }

  private nextOrder(): number {
    const row = this.driver.all<{ value: number }>(
      "SELECT value FROM replica_intent_meta WHERE key = 'nextOrder'",
    )[0];
    return row?.value ?? 1;
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

/** JSON round-trip clone; every stored intent is JSON-safe by contract. */
function clone<T>(value: T): T {
  // eslint-disable-next-line unicorn/prefer-structured-clone -- (#419) React Native 0.81/Hermes ships no structuredClone; intents are JSON-safe by contract and are persisted as JSON anyway; governance: allow-no-unjustified-suppressions runtime capability gap
  return JSON.parse(JSON.stringify(value)) as T;
}

function stringify(record: ReplicaIntent): string {
  return JSON.stringify(record);
}

function parseIntent(json: string): ReplicaIntent {
  return JSON.parse(json) as ReplicaIntent;
}
