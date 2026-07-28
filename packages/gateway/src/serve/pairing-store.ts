/*
 * One-time gateway tickets (issue #555).
 *
 * Founding and enrollment tickets share one discriminated SQLite table.
 * Redemption is a conditional DELETE ... RETURNING, so concurrency is
 * decided by the affected row rather than an in-process mutex.
 */

import crypto from 'node:crypto';
import path from 'node:path';

import type { DeviceEnrollment, EnrollmentStore } from './enrollment-store.js';
import {
  clearReservedFoundingVaults,
  FOUNDING_RESERVATION_TTL_MS,
  foundingSlotIsReserved,
  pendingFoundingVaults,
  releaseFounding,
  reserveFoundingWithinTransaction,
  stageReservedFoundingVaults,
} from './founding-reservations.js';
import { GatewayDatabase } from './gateway-db.js';
import type { MemberGrant } from './member-store.js';

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
  member_id: string | null;
  grants_json: string | null;
  created_at: string;
  expires_at: number;
}

const TICKET_COLUMNS =
  'ticket_id, kind, secret_hash, member_id, grants_json, created_at, expires_at';

/** An invitation: which member joins, and the exact authority they hold. */
export interface TicketInvitation {
  memberId: string;
  grants: MemberGrant[];
}

function parseGrants(raw: string | null): MemberGrant[] {
  if (raw === null) return [];
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error('ticket grants are not a list');
  return parsed.map((entry) => {
    const grant = entry as { vaultId?: unknown; role?: unknown };
    if (
      typeof grant.vaultId !== 'string' ||
      (grant.role !== 'admin' && grant.role !== 'write' && grant.role !== 'read')
    ) {
      throw new Error('ticket grant must be {vaultId, role}');
    }
    return { vaultId: grant.vaultId, role: grant.role };
  });
}

export interface FounderEnrollInput {
  endpointId: string;
  vaultIds: string[];
  label: string;
  platform?: string;
  /** Display label for the owner member founding creates (#599 Decision 9). */
  memberLabel?: string;
}

/**
 * Founding auto-creates the owner member — no extra first-run prompt, ever.
 * The founder becomes `admin` of every vault the ceremony materialized, so a
 * fresh install has exactly one member and zero "Unassigned" bindings.
 */
function enrollFounder(
  enrollments: EnrollmentStore,
  input: FounderEnrollInput,
): DeviceEnrollment[] {
  return enrollments.enrollWithinTransaction({
    endpointId: input.endpointId,
    memberLabel: input.memberLabel ?? 'You',
    grants: input.vaultIds.map((vaultId) => ({
      vaultId,
      role: 'admin' as const,
    })),
    label: input.label,
    ...(input.platform === undefined ? {} : { platform: input.platform }),
  });
}

function invitationOf(row: TicketRow): TicketInvitation | undefined {
  if (row.member_id === null) return undefined;
  const grants = parseGrants(row.grants_json);
  return grants.length > 0 ? { memberId: row.member_id, grants } : undefined;
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

  /**
   * Mint an INVITATION (#599 Decision 5). The member and the full grant list
   * are decided here, server-side, and burned into the ticket; the joining
   * device can name neither. Authorization for WHO may mint WHAT lives in
   * `routes/devices-routes.ts` — this store only records the decision.
   */
  mint(
    invitation: TicketInvitation,
    ttlMs = DEFAULT_TICKET_TTL_MS,
  ): { ticketId: string; secret: string; expiresAt: number } {
    if (invitation.grants.length === 0) {
      throw new Error('an invitation must carry at least one vault grant');
    }
    return this.insert('enroll', ttlMs, invitation.memberId, invitation.grants);
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

  redeem(ticketId: string, secret: string): TicketInvitation | undefined {
    const row = this.consume(ticketId, secret, 'enroll');
    return row ? invitationOf(row) : undefined;
  }

  /**
   * One scan, every grant, ONE transaction: the burn, the member's roles, and
   * the device binding commit together or not at all. A failure anywhere —
   * including the injected `beforeEnroll` seam — rolls the ticket back and
   * leaves zero enrollment, never a half-paired device (#599 AC).
   */
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
  ): DeviceEnrollment[] | undefined {
    if (enrollments.gatewayDatabase.file !== this.gatewayDatabase.file) {
      throw new Error('ticket and enrollment stores must share gateway.db');
    }
    return this.gatewayDatabase.transaction(() => {
      const row = this.consumeWithinTransaction(ticketId, secret, 'enroll');
      const invitation = row ? invitationOf(row) : undefined;
      if (!invitation) return undefined;
      beforeEnroll?.();
      return enrollments.enrollWithinTransaction({
        endpointId: input.endpointId,
        memberId: invitation.memberId,
        grants: invitation.grants,
        label: input.label,
        ...(input.platform === undefined ? {} : { platform: input.platform }),
        ...(input.rememberDevice === undefined ? {} : { rememberDevice: input.rememberDevice }),
        ...(input.grantProfile === undefined ? {} : { grantProfile: input.grantProfile }),
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
      memberLabel?: string;
    },
    beforeEnroll?: () => void,
  ): DeviceEnrollment | undefined {
    return this.redeemFoundingAndEnrollMany(
      ticketId,
      secret,
      enrollments,
      {
        endpointId: input.endpointId,
        vaultIds: [input.vaultId],
        label: input.label,
        ...(input.platform === undefined ? {} : { platform: input.platform }),
        ...(input.memberLabel === undefined ? {} : { memberLabel: input.memberLabel }),
      },
      beforeEnroll,
    )?.[0];
  }

  redeemFoundingAndEnrollMany(
    ticketId: string,
    secret: string,
    enrollments: EnrollmentStore,
    input: FounderEnrollInput,
    beforeEnroll?: () => void,
  ): DeviceEnrollment[] | undefined {
    if (enrollments.gatewayDatabase.file !== this.gatewayDatabase.file) {
      throw new Error('ticket and enrollment stores must share gateway.db');
    }
    return this.gatewayDatabase.transaction(() => {
      const row = this.consumeWithinTransaction(ticketId, secret, 'found');
      if (!row) return undefined;
      beforeEnroll?.();
      return enrollFounder(enrollments, input);
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
          `SELECT ${TICKET_COLUMNS}
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

  pendingFoundingVaults(): Array<{
    reservationId: string;
    vaultIds: string[];
  }> {
    return pendingFoundingVaults(this.gatewayDatabase);
  }

  redeemReservedFoundingAndEnrollMany(
    reservationId: string,
    enrollments: EnrollmentStore,
    input: FounderEnrollInput,
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
      const enrolled = enrollFounder(enrollments, input);
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
        `SELECT ${TICKET_COLUMNS}
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
    memberId: string;
    grants: MemberGrant[];
    expiresAt: number;
  }> {
    const now = Date.now();
    return (
      this.gatewayDatabase.db
        .prepare(
          `SELECT ${TICKET_COLUMNS}
             FROM tickets WHERE kind = 'enroll' AND expires_at > ? ORDER BY created_at`,
        )
        .all(now) as unknown as TicketRow[]
    ).flatMap((row) => {
      const invitation = invitationOf(row);
      return invitation
        ? [
            {
              ...invitation,
              ticketId: row.ticket_id,
              expiresAt: row.expires_at,
            },
          ]
        : [];
    });
  }

  private insert(
    kind: 'found' | 'enroll',
    ttlMs: number,
    memberId: string | null,
    grants: readonly MemberGrant[] | null,
  ): { ticketId: string; secret: string; expiresAt: number } {
    return this.gatewayDatabase.transaction(() =>
      this.insertWithinTransaction(kind, ttlMs, memberId, grants),
    );
  }

  private insertWithinTransaction(
    kind: 'found' | 'enroll',
    ttlMs: number,
    memberId: string | null,
    grants: readonly MemberGrant[] | null,
  ): { ticketId: string; secret: string; expiresAt: number } {
    const ticketId = crypto.randomUUID();
    const secret = crypto.randomBytes(32).toString('base64url');
    const expiresAt = Date.now() + ttlMs;
    this.gatewayDatabase.db
      .prepare(
        `INSERT INTO tickets (
          ticket_id, kind, secret_hash, member_id, grants_json, created_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        ticketId,
        kind,
        hashSecret(secret),
        memberId,
        grants === null ? null : JSON.stringify(grants),
        new Date().toISOString(),
        expiresAt,
      );
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
        `SELECT ${TICKET_COLUMNS}
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
