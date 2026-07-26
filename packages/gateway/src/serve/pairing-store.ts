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

export interface PairingTicketPayload {
  v: 1;
  kind: 'centraid-gw-pair';
  gw: string;
  t: string;
  s: string;
  vaultName: string;
  exp: number;
}

export interface FoundingTicketPayload {
  v: 1;
  kind: 'centraid-gw-found';
  gw: string;
  t: string;
  s: string;
  exp: number;
}

export function encodePairingTicket(payload: PairingTicketPayload | FoundingTicketPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

export function parsePairingTicket(raw: string): PairingTicketPayload | undefined {
  try {
    const obj = JSON.parse(
      Buffer.from(raw.trim(), 'base64url').toString('utf8'),
    ) as Partial<PairingTicketPayload>;
    if (obj.v !== 1 || obj.kind !== 'centraid-gw-pair') return undefined;
    if (typeof obj.gw !== 'string' || typeof obj.t !== 'string' || typeof obj.s !== 'string') {
      return undefined;
    }
    if (typeof obj.vaultName !== 'string' || typeof obj.exp !== 'number') return undefined;
    return obj as PairingTicketPayload;
  } catch {
    return undefined;
  }
}

export function parseFoundingTicket(raw: string): FoundingTicketPayload | undefined {
  try {
    const obj = JSON.parse(
      Buffer.from(raw.trim(), 'base64url').toString('utf8'),
    ) as Partial<FoundingTicketPayload>;
    if (obj.v !== 1 || obj.kind !== 'centraid-gw-found') return undefined;
    if (typeof obj.gw !== 'string' || typeof obj.t !== 'string' || typeof obj.s !== 'string') {
      return undefined;
    }
    if (typeof obj.exp !== 'number') return undefined;
    return obj as FoundingTicketPayload;
  } catch {
    return undefined;
  }
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

  mintFounding(ttlMs = FOUNDING_TICKET_TTL_MS): {
    ticketId: string;
    secret: string;
    expiresAt: number;
  } {
    return this.gatewayDatabase.transaction(() => {
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

  hasActiveFounding(): boolean {
    const row = this.gatewayDatabase.db
      .prepare("SELECT 1 AS active FROM tickets WHERE kind = 'found' AND expires_at > ? LIMIT 1")
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
    const deleted = this.gatewayDatabase.db
      .prepare('DELETE FROM tickets WHERE ticket_id = ? AND kind = ?')
      .run(ticketId, kind);
    // BEGIN IMMEDIATE serializes contenders. The affected row count, rather
    // than any in-process mutex, is the single-use authority.
    if (deleted.changes !== 1) return undefined;
    if (row.expires_at <= Date.now()) return undefined;
    const expected = Buffer.from(row.secret_hash, 'hex');
    const actual = Buffer.from(hashSecret(secret), 'hex');
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual)
      ? row
      : undefined;
  }
}
