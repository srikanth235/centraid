/*
 * One-time gateway enrollment tickets (issues #555, #603).
 *
 * A ticket is an INVITATION: it names the member a joining device binds to
 * and the exact grants that member must hold. Redemption is a conditional
 * DELETE, so concurrency is decided by the affected row rather than an
 * in-process mutex.
 */

import crypto from "node:crypto";
import path from "node:path";

import type { DeviceEnrollment, EnrollmentStore } from "./enrollment-store.js";
import { GatewayDatabase } from "./gateway-db.js";
import type { MemberGrant } from "./member-store.js";

export {
  encodePairingTicket,
  parsePairingTicket,
} from "./pairing-ticket-codec.js";

export const DEFAULT_TICKET_TTL_MS = 15 * 60 * 1000;

interface TicketRow {
  ticket_id: string;
  secret_hash: string;
  member_id: string;
  grants_json: string;
  created_at: string;
  expires_at: number;
}

const TICKET_COLUMNS =
  "ticket_id, secret_hash, member_id, grants_json, created_at, expires_at";

/** An invitation: which member joins, and the exact authority they hold. */
export interface TicketInvitation {
  memberId: string;
  grants: MemberGrant[];
}

function parseGrants(raw: string): MemberGrant[] {
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error("ticket grants are not a list");
  return parsed.map((entry) => {
    const grant = entry as { vaultId?: unknown; role?: unknown };
    if (
      typeof grant.vaultId !== "string" ||
      (grant.role !== "admin" &&
        grant.role !== "write" &&
        grant.role !== "read")
    ) {
      throw new Error("ticket grant must be {vaultId, role}");
    }
    return { vaultId: grant.vaultId, role: grant.role };
  });
}

/** Every stored ticket carries a member and grants — the DDL CHECK says so. */
function invitationOf(row: TicketRow): TicketInvitation {
  return { memberId: row.member_id, grants: parseGrants(row.grants_json) };
}

function hashSecret(secret: string): string {
  return crypto.createHash("sha256").update(secret, "utf8").digest("hex");
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
    ttlMs = DEFAULT_TICKET_TTL_MS
  ): { ticketId: string; secret: string; expiresAt: number } {
    if (invitation.grants.length === 0) {
      throw new Error("an invitation must carry at least one vault grant");
    }
    return this.insert(ttlMs, invitation.memberId, invitation.grants);
  }

  redeem(ticketId: string, secret: string): TicketInvitation | undefined {
    const row = this.consume(ticketId, secret);
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
    beforeEnroll?: () => void
  ): DeviceEnrollment[] | undefined {
    if (enrollments.gatewayDatabase.file !== this.gatewayDatabase.file) {
      throw new Error("ticket and enrollment stores must share gateway.db");
    }
    return this.gatewayDatabase.transaction(() => {
      const row = this.consumeWithinTransaction(ticketId, secret);
      if (!row) return undefined;
      const invitation = invitationOf(row);
      beforeEnroll?.();
      return enrollments.enrollWithinTransaction({
        endpointId: input.endpointId,
        memberId: invitation.memberId,
        grants: invitation.grants,
        label: input.label,
        ...(input.platform === undefined ? {} : { platform: input.platform }),
        ...(input.rememberDevice === undefined
          ? {}
          : { rememberDevice: input.rememberDevice }),
        ...(input.grantProfile === undefined
          ? {}
          : { grantProfile: input.grantProfile }),
      });
    });
  }

  listActive(): Array<{
    ticketId: string;
    memberId: string;
    grants: MemberGrant[];
    createdAt: string;
    expiresAt: number;
  }> {
    const now = Date.now();
    return (
      this.gatewayDatabase.db
        .prepare(
          `SELECT ${TICKET_COLUMNS}
             FROM tickets WHERE expires_at > ? ORDER BY created_at`
        )
        .all(now) as unknown as TicketRow[]
    ).map((row) => ({
      ...invitationOf(row),
      ticketId: row.ticket_id,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
    }));
  }

  private insert(
    ttlMs: number,
    memberId: string,
    grants: readonly MemberGrant[]
  ): { ticketId: string; secret: string; expiresAt: number } {
    const ticketId = crypto.randomUUID();
    const secret = crypto.randomBytes(32).toString("base64url");
    const expiresAt = Date.now() + ttlMs;
    this.gatewayDatabase.db
      .prepare(
        `INSERT INTO tickets (
          ticket_id, secret_hash, member_id, grants_json, created_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        ticketId,
        hashSecret(secret),
        memberId,
        JSON.stringify(grants),
        new Date().toISOString(),
        expiresAt
      );
    return { ticketId, secret, expiresAt };
  }

  private consume(ticketId: string, secret: string): TicketRow | undefined {
    return this.gatewayDatabase.transaction(() =>
      this.consumeWithinTransaction(ticketId, secret)
    );
  }

  private consumeWithinTransaction(
    ticketId: string,
    secret: string
  ): TicketRow | undefined {
    const row = this.gatewayDatabase.db
      .prepare(
        `SELECT ${TICKET_COLUMNS}
           FROM tickets
          WHERE ticket_id = ?`
      )
      .get(ticketId) as TicketRow | undefined;
    if (!row) return undefined;
    if (row.expires_at <= Date.now()) return undefined;
    const expected = Buffer.from(row.secret_hash, "hex");
    const actual = Buffer.from(hashSecret(secret), "hex");
    if (
      expected.length !== actual.length ||
      !crypto.timingSafeEqual(expected, actual)
    ) {
      return undefined;
    }
    const deleted = this.gatewayDatabase.db
      .prepare("DELETE FROM tickets WHERE ticket_id = ?")
      .run(ticketId);
    // BEGIN IMMEDIATE serializes contenders. The affected row count, rather
    // than any in-process mutex, is the single-use authority.
    if (deleted.changes !== 1) return undefined;
    return row;
  }
}
