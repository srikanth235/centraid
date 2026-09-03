import crypto from "node:crypto";
import path from "node:path";

import type { DeviceEnrollment, EnrollmentStore } from "./enrollment-store.js";
import { GatewayDatabase } from "./gateway-db.js";

export {
  encodePairingTicket,
  parsePairingTicket,
} from "./pairing-ticket-codec.js";

export const DEFAULT_TICKET_TTL_MS = 15 * 60 * 1000;

interface TicketRow {
  ticket_id: string;
  secret_hash: string;
  owner_id: string;
  grants_json: string;
  created_at: string;
  expires_at: number;
}

const TICKET_COLUMNS =
  "ticket_id, secret_hash, owner_id, grants_json, created_at, expires_at";

export interface TicketInvitation {
  ownerId: string;
  vaultIds: string[];
}

function parseVaultIds(raw: string): string[] {
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error("ticket vaults are not a list");
  return parsed.map((entry) => {
    if (typeof entry !== "string" || entry.length === 0) {
      throw new Error("ticket vault entry must be a vault id");
    }
    return entry;
  });
}

function invitationOf(row: TicketRow): TicketInvitation {
  return { ownerId: row.owner_id, vaultIds: parseVaultIds(row.grants_json) };
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

  mint(
    invitation: TicketInvitation,
    ttlMs = DEFAULT_TICKET_TTL_MS
  ): { ticketId: string; secret: string; expiresAt: number } {
    if (invitation.vaultIds.length === 0) {
      throw new Error("an invitation must carry at least one vault");
    }
    return this.insert(ttlMs, invitation.ownerId, invitation.vaultIds);
  }

  redeem(ticketId: string, secret: string): TicketInvitation | undefined {
    const row = this.consume(ticketId, secret);
    return row ? invitationOf(row) : undefined;
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
        ownerId: invitation.ownerId,
        vaultIds: invitation.vaultIds,
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
    ownerId: string;
    vaultIds: string[];
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
    ownerId: string,
    vaultIds: readonly string[]
  ): { ticketId: string; secret: string; expiresAt: number } {
    const ticketId = crypto.randomUUID();
    const secret = crypto.randomBytes(32).toString("base64url");
    const expiresAt = Date.now() + ttlMs;
    this.gatewayDatabase.db
      .prepare(
        `INSERT INTO tickets (
          ticket_id, secret_hash, owner_id, grants_json, created_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        ticketId,
        hashSecret(secret),
        ownerId,
        JSON.stringify(vaultIds),
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
    if (deleted.changes !== 1) return undefined;
    return row;
  }
}
