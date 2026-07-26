/* Gateway-wide recovery-kit fingerprint/confirmation row (issue #555). */
import { GatewayDatabase } from '../serve/gateway-db.js';

export interface RecoveryKitState {
  /** Epoch SECONDS the operator last confirmed, or `null` if never. */
  confirmedAt: number | null;
  kitFingerprint?: string;
}

export async function loadRecoveryKitState(dir: string): Promise<RecoveryKitState> {
  const database = GatewayDatabase.open(dir);
  try {
    return await new RecoveryKitStateStore(database).status();
  } finally {
    database.close();
  }
}

export async function saveRecoveryKitState(dir: string, state: RecoveryKitState): Promise<void> {
  const database = GatewayDatabase.open(dir);
  try {
    if (state.kitFingerprint) {
      await new RecoveryKitStateStore(database).begin(state.kitFingerprint);
    }
    if (state.confirmedAt !== null) await new RecoveryKitStateStore(database).confirm();
  } finally {
    database.close();
  }
}

/** Thin object wrapper (constructor-injectable) — `BackupService` and the storage routes share one instance. */
export class RecoveryKitStateStore {
  constructor(
    private readonly source: string | GatewayDatabase,
    private readonly now: () => number = Date.now,
  ) {}

  async status(): Promise<RecoveryKitState> {
    if (!(this.source instanceof GatewayDatabase)) return loadRecoveryKitState(this.source);
    const row = this.source.db
      .prepare('SELECT confirmed_at, kit_fingerprint FROM recovery_kit WHERE singleton = 1')
      .get() as { confirmed_at: number | null; kit_fingerprint: string | null } | undefined;
    return {
      confirmedAt: row?.confirmed_at ?? null,
      ...(row?.kit_fingerprint ? { kitFingerprint: row.kit_fingerprint } : {}),
    };
  }

  /**
   * Synchronous request gate for the founding ceremony. A missing row means
   * no ceremony is active; only an issued-but-unverified kit blocks use.
   */
  ceremonyIncomplete(): boolean {
    if (!(this.source instanceof GatewayDatabase)) {
      throw new Error('ceremonyIncomplete requires the live gateway database');
    }
    const row = this.source.db
      .prepare('SELECT kit_confirmed FROM recovery_kit WHERE singleton = 1')
      .get() as { kit_confirmed: number } | undefined;
    return row?.kit_confirmed === 0;
  }

  async begin(fingerprint: string): Promise<RecoveryKitState> {
    if (!(this.source instanceof GatewayDatabase)) {
      const database = GatewayDatabase.open(this.source);
      try {
        return await new RecoveryKitStateStore(database, this.now).begin(fingerprint);
      } finally {
        database.close();
      }
    }
    this.source.db
      .prepare(
        `INSERT INTO recovery_kit (
           singleton, confirmed_at, kit_fingerprint, kit_confirmed
         ) VALUES (1, NULL, ?, 0)
         ON CONFLICT(singleton) DO UPDATE SET
           confirmed_at = NULL,
           kit_fingerprint = excluded.kit_fingerprint,
           kit_confirmed = 0`,
      )
      .run(fingerprint);
    return { confirmedAt: null, kitFingerprint: fingerprint };
  }

  async verify(fingerprint: string): Promise<RecoveryKitState | undefined> {
    if (!(this.source instanceof GatewayDatabase)) {
      const database = GatewayDatabase.open(this.source);
      try {
        return await new RecoveryKitStateStore(database, this.now).verify(fingerprint);
      } finally {
        database.close();
      }
    }
    const confirmedAt = Math.floor(this.now() / 1000);
    const result = this.source.db
      .prepare(
        `UPDATE recovery_kit
            SET confirmed_at = ?, kit_confirmed = 1
          WHERE singleton = 1 AND kit_fingerprint = ?`,
      )
      .run(confirmedAt, fingerprint);
    if (result.changes !== 1) return undefined;
    return { confirmedAt, kitFingerprint: fingerprint };
  }

  /** One-way: confirming again just refreshes the timestamp. */
  async confirm(): Promise<RecoveryKitState> {
    const state: RecoveryKitState = { confirmedAt: Math.floor(this.now() / 1000) };
    if (this.source instanceof GatewayDatabase) {
      this.source.db
        .prepare(
          `INSERT INTO recovery_kit (singleton, confirmed_at, kit_confirmed)
           VALUES (1, ?, 1)
           ON CONFLICT(singleton) DO UPDATE SET
             confirmed_at = excluded.confirmed_at,
             kit_confirmed = 1`,
        )
        .run(state.confirmedAt);
    } else await saveRecoveryKitState(this.source, state);
    return state;
  }
}
