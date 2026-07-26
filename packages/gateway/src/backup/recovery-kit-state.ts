/* Gateway-wide recovery-kit fingerprint/confirmation row (issue #555). */
import { GatewayDatabase } from '../serve/gateway-db.js';

export interface RecoveryKitState {
  /** Epoch SECONDS the operator last confirmed, or `null` if never. */
  confirmedAt: number | null;
  kitFingerprint?: string;
}

/** Thin object wrapper (constructor-injectable) — `BackupService` and the storage routes share one instance. */
export class RecoveryKitStateStore {
  constructor(
    private readonly source: string | GatewayDatabase,
    private readonly now: () => number = Date.now,
  ) {}

  async status(): Promise<RecoveryKitState> {
    if (!(this.source instanceof GatewayDatabase)) {
      const database = GatewayDatabase.open(this.source);
      try {
        return await new RecoveryKitStateStore(database, this.now).status();
      } finally {
        database.close();
      }
    }
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
      .prepare('SELECT founding_pending FROM recovery_kit WHERE singleton = 1')
      .get() as { founding_pending: number } | undefined;
    return row?.founding_pending === 1;
  }

  async begin(
    fingerprint: string,
    options: { founding?: boolean } = {},
  ): Promise<RecoveryKitState> {
    if (!(this.source instanceof GatewayDatabase)) {
      const database = GatewayDatabase.open(this.source);
      try {
        return await new RecoveryKitStateStore(database, this.now).begin(fingerprint, options);
      } finally {
        database.close();
      }
    }
    return this.beginWithinTransaction(fingerprint, options);
  }

  /**
   * Write the pending-kit state on the live gateway handle. Founding calls
   * this from the same gateway.db transaction that consumes the capability
   * and enrolls the first owner, so a crash cannot commit only half of that
   * durable transition.
   */
  beginWithinTransaction(
    fingerprint: string,
    options: { founding?: boolean } = {},
  ): RecoveryKitState {
    if (!(this.source instanceof GatewayDatabase)) {
      throw new Error('beginWithinTransaction requires the live gateway database');
    }
    this.source.db
      .prepare(
        `INSERT INTO recovery_kit (
           singleton, confirmed_at, kit_fingerprint, kit_confirmed, founding_pending
         ) VALUES (1, NULL, ?, 0, ?)
         ON CONFLICT(singleton) DO UPDATE SET
           confirmed_at = NULL,
           kit_fingerprint = excluded.kit_fingerprint,
           kit_confirmed = 0,
           founding_pending = excluded.founding_pending`,
      )
      .run(fingerprint, options.founding === true ? 1 : 0);
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
            SET confirmed_at = ?, kit_confirmed = 1, founding_pending = 0
          WHERE singleton = 1 AND kit_fingerprint = ?`,
      )
      .run(confirmedAt, fingerprint);
    if (result.changes !== 1) return undefined;
    return { confirmedAt, kitFingerprint: fingerprint };
  }
}
