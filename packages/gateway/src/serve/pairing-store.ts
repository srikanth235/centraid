/*
 * One-time gateway tickets (issue #555).
 *
 * Founding and enrollment tickets share one discriminated SQLite table.
 * Redemption is a conditional DELETE ... RETURNING, so concurrency is
 * decided by the affected row rather than an in-process mutex.
 */

import crypto from 'node:crypto';
import path from 'node:path';
import type { GrantableTrust, DeviceEnrollment, EnrollmentStore } from './enrollment-store.js';
import { GatewayDatabase } from './gateway-db.js';
import {
  clearReservedFoundingVaults,
  FOUNDING_RESERVATION_TTL_MS,
  foundingSlotIsReserved,
  pendingFoundingVaults,
  releaseFounding,
  reserveFoundingWithinTransaction,
  stageReservedFoundingVaults,
} from './founding-reservations.js';

export {
  encodePairingTicket,
  parseFoundingTicket,
  parsePairingTicket,
} from './pairing-ticket-codec.js';

export const DEFAULT_TICKET_TTL_MS = 15 * 60 * 1000;
export const FOUNDING_TICKET_TTL_MS = 10 * 60 * 1000;

interface TicketRow {
  ticket_id: string;
  kind: 'found' | 'enroll';
  secret_hash: string;
  vault_id: string | null;
  trust: GrantableTrust | null;
  created_at: string;
  expires_at: number;
}

function hashSecret(secret: string): string {
  return crypto.createHash('sha256').update(secret, 'utf8').digest('hex');
}

function databaseFor(source: string | GatewayDatabase): GatewayDatabase {
  if (source instanceof GatewayDatabase) return source;
  return GatewayDatabase.open(path.dirname(path.resolve(source)));
}

export class PairingTicketStore {
  readonly gatewayDatabase: GatewayDatabase;

  private constructor(gatewayDatabase: GatewayDatabase) {
    this.gatewayDatabase = gatewayDatabase;
  }

  static open(source: string | GatewayDatabase): PairingTicketStore {
    return new PairingTicketStore(databaseFor(source));
  }

  mint(
    vaultId: string,
    ttlMs = DEFAULT_TICKET_TTL_MS,
    trust: GrantableTrust = 'full',
  ): { ticketId: string; secret: string; expiresAt: number } {
    return this.insert('enroll', ttlMs, vaultId, trust);
  }

  /**
   * Mint the single founding capability, superseding any earlier one.
   *
   * Returns `undefined` when the existing ticket carries a LIVE reservation
   * (issue #568 item K). A reservation means a ceremony is in flight — its
   * holder may be minutes into a multi-gigabyte restore — and
   * `founding_ticket_reservations` cascades on ticket delete, so replacing
   * the row would make the commit's `changes !== 1` check fail and send
   * `rollbackFoundingVaults` to `rmSync` a fully restored vault along with
   * its sealing key. `one_founding_ticket` allows only one row, so refusing
   * is the only safe answer; the reservation's own TTL bounds the wait.
   * Superseding an UNRESERVED ticket is still the point of this verb: the
   * host asked for a new QR.
   */
  mintFounding(ttlMs = FOUNDING_TICKET_TTL_MS):
    | {
        ticketId: string;
        secret: string;
        expiresAt: number;
      }
    | undefined {
    return this.gatewayDatabase.transaction(() => {
      if (foundingSlotIsReserved(this.gatewayDatabase)) return undefined;
      this.gatewayDatabase.db.prepare("DELETE FROM tickets WHERE kind = 'found'").run();
      return this.insertWithinTransaction('found', ttlMs, null, null);
    });
  }

  redeem(ticketId: string, secret: string): { vaultId: string; trust: GrantableTrust } | undefined {
    const row = this.consume(ticketId, secret, 'enroll');
    if (!row?.vault_id || !row.trust) return undefined;
    return { vaultId: row.vault_id, trust: row.trust };
  }

  redeemAndEnroll(
    ticketId: string,
    secret: string,
    enrollments: EnrollmentStore,
    input: {
      endpointId: string;
      label: string;
      platform?: string;
      rememberDevice?: boolean;
      grantProfile?: string[];
    },
    beforeEnroll?: () => void,
  ): DeviceEnrollment | undefined {
    if (enrollments.gatewayDatabase.file !== this.gatewayDatabase.file) {
      throw new Error('ticket and enrollment stores must share gateway.db');
    }
    return this.gatewayDatabase.transaction(() => {
      const row = this.consumeWithinTransaction(ticketId, secret, 'enroll');
      if (!row?.vault_id || !row.trust) return undefined;
      beforeEnroll?.();
      return enrollments.enrollWithinTransaction({
        endpointId: input.endpointId,
        vaultId: row.vault_id,
        label: input.label,
        ...(input.platform !== undefined ? { platform: input.platform } : {}),
        ...(input.rememberDevice !== undefined ? { rememberDevice: input.rememberDevice } : {}),
        ...(input.grantProfile !== undefined ? { grantProfile: input.grantProfile } : {}),
        trust: row.trust,
      });
    });
  }

  redeemFounding(ticketId: string, secret: string): boolean {
    return this.consume(ticketId, secret, 'found') !== undefined;
  }

  redeemFoundingAndEnroll(
    ticketId: string,
    secret: string,
    enrollments: EnrollmentStore,
    input: {
      endpointId: string;
      vaultId: string;
      label: string;
      platform?: string;
    },
    beforeEnroll?: () => void,
  ): DeviceEnrollment | undefined {
    return this.redeemFoundingAndEnrollMany(
      ticketId,
      secret,
      enrollments,
      {
        ...input,
        vaultIds: [input.vaultId],
      },
      beforeEnroll,
    )?.[0];
  }

  redeemFoundingAndEnrollMany(
    ticketId: string,
    secret: string,
    enrollments: EnrollmentStore,
    input: {
      endpointId: string;
      vaultIds: string[];
      label: string;
      platform?: string;
    },
    beforeEnroll?: () => void,
  ): DeviceEnrollment[] | undefined {
    if (enrollments.gatewayDatabase.file !== this.gatewayDatabase.file) {
      throw new Error('ticket and enrollment stores must share gateway.db');
    }
    return this.gatewayDatabase.transaction(() => {
      const row = this.consumeWithinTransaction(ticketId, secret, 'found');
      if (!row) return undefined;
      beforeEnroll?.();
      return input.vaultIds.map((vaultId) =>
        enrollments.enrollWithinTransaction({
          endpointId: input.endpointId,
          vaultId,
          label: input.label,
          ...(input.platform !== undefined ? { platform: input.platform } : {}),
          trust: 'owner',
        }),
      );
    });
  }

  /**
   * Atomically reserve a valid founding capability before doing slow or
   * filesystem-mutating work. The original ten-minute window decides whether
   * work may start; the opaque reservation keeps that one caller's ceremony
   * alive long enough to finish without making the ticket reusable.
   */
  reserveFounding(
    ticketId: string,
    secret: string,
    ttlMs = FOUNDING_RESERVATION_TTL_MS,
  ): string | undefined {
    return this.gatewayDatabase.transaction(() => {
      const row = this.gatewayDatabase.db
        .prepare(
          `SELECT ticket_id, kind, secret_hash, vault_id, trust, created_at, expires_at
             FROM tickets
            WHERE ticket_id = ? AND kind = 'found'`,
        )
        .get(ticketId) as TicketRow | undefined;
      if (!row) return undefined;
      const expected = Buffer.from(row.secret_hash, 'hex');
      const actual = Buffer.from(hashSecret(secret), 'hex');
      if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
        return undefined;
      }
      return reserveFoundingWithinTransaction(this.gatewayDatabase, {
        ticketId,
        secretHash: row.secret_hash,
        expiresAt: row.expires_at,
        ttlMs,
      });
    });
  }

  /** See `founding-reservations.ts` — the reservation table owns these. */
  stageReservedFoundingVaults(reservationId: string, vaultIds: readonly string[]): boolean {
    return stageReservedFoundingVaults(this.gatewayDatabase, reservationId, vaultIds);
  }

  releaseFounding(reservationId: string): void {
    releaseFounding(this.gatewayDatabase, reservationId);
  }

  clearReservedFoundingVaults(reservationId: string, vaultIds: readonly string[]): void {
    clearReservedFoundingVaults(this.gatewayDatabase, reservationId, vaultIds);
  }

  pendingFoundingVaults(): Array<{ reservationId: string; vaultIds: string[] }> {
    return pendingFoundingVaults(this.gatewayDatabase);
  }

  redeemReservedFoundingAndEnrollMany(
    reservationId: string,
    enrollments: EnrollmentStore,
    input: {
      endpointId: string;
      vaultIds: string[];
      label: string;
      platform?: string;
    },
    beforeEnroll?: () => void,
    afterEnroll?: () => void,
  ): DeviceEnrollment[] | undefined {
    if (enrollments.gatewayDatabase.file !== this.gatewayDatabase.file) {
      throw new Error('ticket and enrollment stores must share gateway.db');
    }
    return this.gatewayDatabase.transaction(() => {
      const reservation = this.gatewayDatabase.db
        .prepare(
          `SELECT ticket_id
             FROM founding_ticket_reservations
            WHERE reservation_id = ? AND reserved_until > ?`,
        )
        .get(reservationId, Date.now()) as { ticket_id: string } | undefined;
      if (!reservation) return undefined;
      const deleted = this.gatewayDatabase.db
        .prepare("DELETE FROM tickets WHERE ticket_id = ? AND kind = 'found'")
        .run(reservation.ticket_id);
      if (deleted.changes !== 1) return undefined;
      beforeEnroll?.();
      const enrolled = input.vaultIds.map((vaultId) =>
        enrollments.enrollWithinTransaction({
          endpointId: input.endpointId,
          vaultId,
          label: input.label,
          ...(input.platform !== undefined ? { platform: input.platform } : {}),
          trust: 'owner',
        }),
      );
      afterEnroll?.();
      return enrolled;
    });
  }

  /**
   * Is the admit-anyone founding window open? (issue #568 item C.)
   *
   * A fresh gateway has no enrollments, so the QUIC listener must admit an
   * unknown EndpointId for the founding ceremony to be reachable at all.
   * That window is deliberately keyed to `FOUNDING_TICKET_TTL_MS` — the ten
   * minutes the QR is valid for — and NOT to `FOUNDING_RESERVATION_TTL_MS`.
   * The reservation exists to keep ONE already-admitted caller's slow
   * restore alive; stretching admission to two hours would widen the blast
   * radius of a leaked dial ticket twelvefold for no ceremony benefit.
   */
  hasOpenFoundingWindow(): boolean {
    const row = this.gatewayDatabase.db
      .prepare(
        `SELECT 1 AS active
           FROM tickets
          WHERE kind = 'found' AND expires_at > ?
          LIMIT 1`,
      )
      .get(Date.now()) as { active: number } | undefined;
    return row?.active === 1;
  }

  /**
   * Non-consuming preflight for a potentially long restore. Final authority is
   * still `redeemFoundingAndEnroll`'s conditional DELETE; this only prevents
   * downloading a backup for an already-invalid capability.
   */
  validatesFounding(ticketId: string, secret: string): boolean {
    const row = this.gatewayDatabase.db
      .prepare(
        `SELECT ticket_id, kind, secret_hash, vault_id, trust, created_at, expires_at
           FROM tickets
          WHERE ticket_id = ? AND kind = 'found' AND expires_at > ?`,
      )
      .get(ticketId, Date.now()) as TicketRow | undefined;
    if (!row) return false;
    const expected = Buffer.from(row.secret_hash, 'hex');
    const actual = Buffer.from(hashSecret(secret), 'hex');
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  }

  listActive(): Array<{
    ticketId: string;
    vaultId: string;
    trust: GrantableTrust;
    expiresAt: number;
  }> {
    const now = Date.now();
    return (
      this.gatewayDatabase.db
        .prepare(
          `SELECT ticket_id, kind, secret_hash, vault_id, trust, created_at, expires_at
             FROM tickets WHERE kind = 'enroll' AND expires_at > ? ORDER BY created_at`,
        )
        .all(now) as unknown as TicketRow[]
    ).flatMap((row) =>
      row.vault_id && row.trust
        ? [
            {
              ticketId: row.ticket_id,
              vaultId: row.vault_id,
              trust: row.trust,
              expiresAt: row.expires_at,
            },
          ]
        : [],
    );
  }

  private insert(
    kind: 'found' | 'enroll',
    ttlMs: number,
    vaultId: string | null,
    trust: GrantableTrust | null,
  ): { ticketId: string; secret: string; expiresAt: number } {
    return this.gatewayDatabase.transaction(() =>
      this.insertWithinTransaction(kind, ttlMs, vaultId, trust),
    );
  }

  private insertWithinTransaction(
    kind: 'found' | 'enroll',
    ttlMs: number,
    vaultId: string | null,
    trust: GrantableTrust | null,
  ): { ticketId: string; secret: string; expiresAt: number } {
    const ticketId = crypto.randomUUID();
    const secret = crypto.randomBytes(32).toString('base64url');
    const expiresAt = Date.now() + ttlMs;
    this.gatewayDatabase.db
      .prepare(
        `INSERT INTO tickets (
          ticket_id, kind, secret_hash, vault_id, trust, created_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(ticketId, kind, hashSecret(secret), vaultId, trust, new Date().toISOString(), expiresAt);
    return { ticketId, secret, expiresAt };
  }

  private consume(
    ticketId: string,
    secret: string,
    kind: 'found' | 'enroll',
  ): TicketRow | undefined {
    return this.gatewayDatabase.transaction(() =>
      this.consumeWithinTransaction(ticketId, secret, kind),
    );
  }

  private consumeWithinTransaction(
    ticketId: string,
    secret: string,
    kind: 'found' | 'enroll',
  ): TicketRow | undefined {
    const row = this.gatewayDatabase.db
      .prepare(
        `SELECT ticket_id, kind, secret_hash, vault_id, trust, created_at, expires_at
           FROM tickets
          WHERE ticket_id = ? AND kind = ?`,
      )
      .get(ticketId, kind) as TicketRow | undefined;
    if (!row) return undefined;
    if (row.expires_at <= Date.now()) return undefined;
    const expected = Buffer.from(row.secret_hash, 'hex');
    const actual = Buffer.from(hashSecret(secret), 'hex');
    if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
      return undefined;
    }
    const deleted = this.gatewayDatabase.db
      .prepare('DELETE FROM tickets WHERE ticket_id = ? AND kind = ?')
      .run(ticketId, kind);
    // BEGIN IMMEDIATE serializes contenders. The affected row count, rather
    // than any in-process mutex, is the single-use authority.
    if (deleted.changes !== 1) return undefined;
    return row;
  }
}
